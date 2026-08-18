#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_NOFOLLOW
#error "anchored private state requires O_NOFOLLOW"
#endif

static const int directory_fd = 3;
static const char *pending_temporary = NULL;

static void cleanup_temporary(void) {
  if (pending_temporary != NULL) unlinkat(directory_fd, pending_temporary, 0);
}

static void fail(const char *message) {
  int saved = errno;
  cleanup_temporary();
  errno = saved;
  fprintf(stderr, "anchored-private-state: %s: %s\n", message, strerror(errno));
  exit(errno == ENOENT ? 2 : 1);
}

static void reject(const char *message) {
  cleanup_temporary();
  fprintf(stderr, "anchored-private-state: %s\n", message);
  exit(1);
}

static void validate_name(const char *name) {
  size_t length = strlen(name);
  if (length == 0 || length > 255 || strcmp(name, ".") == 0 || strcmp(name, "..") == 0
      || strchr(name, '/') != NULL) reject("invalid basename");
}

static void validate_directory(void) {
  struct stat state;
  if (fstat(directory_fd, &state) != 0) fail("cannot inspect directory descriptor");
  if (!S_ISDIR(state.st_mode) || state.st_uid != geteuid() || (state.st_mode & 077) != 0) {
    reject("directory descriptor is not an owner-only directory");
  }
}

static void validate_file(const struct stat *state) {
  if (!S_ISREG(state->st_mode) || state->st_uid != geteuid() || (state->st_mode & 077) != 0) {
    reject("private state is not an owner-only regular file");
  }
}

static unsigned long long parse_limit(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long result = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || result == 0) reject("invalid size limit");
  return result;
}

static void copy_fd(int input, int output, unsigned long long limit) {
  unsigned char buffer[16384];
  unsigned long long total = 0;
  for (;;) {
    ssize_t count = read(input, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) continue;
      fail("read failed");
    }
    if (count == 0) return;
    if ((unsigned long long) count > limit - total) reject("private state exceeds its size limit");
    total += (unsigned long long) count;
    size_t offset = 0;
    while (offset < (size_t) count) {
      ssize_t written = write(output, buffer + offset, (size_t) count - offset);
      if (written < 0) {
        if (errno == EINTR) continue;
        fail("write failed");
      }
      offset += (size_t) written;
    }
  }
}

static void read_file(const char *name, const char *limit_text) {
  validate_name(name);
  unsigned long long limit = parse_limit(limit_text);
  int fd = openat(directory_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) fail("cannot open private state");
  struct stat state;
  if (fstat(fd, &state) != 0) fail("cannot inspect private state");
  validate_file(&state);
  if (state.st_size < 0 || (unsigned long long) state.st_size > limit) {
    reject("private state exceeds its size limit");
  }
  copy_fd(fd, STDOUT_FILENO, limit);
  if (close(fd) != 0) fail("cannot close private state");
}

static void inspect_destination(const char *name) {
  struct stat state;
  if (fstatat(directory_fd, name, &state, AT_SYMLINK_NOFOLLOW) == 0) {
    validate_file(&state);
    return;
  }
  if (errno != ENOENT) fail("cannot inspect private-state destination");
}

static void write_file(const char *name, const char *temporary, const char *limit_text) {
  validate_name(name);
  validate_name(temporary);
  if (strcmp(name, temporary) == 0) reject("temporary name must differ from destination");
  unsigned long long limit = parse_limit(limit_text);
  inspect_destination(name);
  int fd = openat(directory_fd, temporary,
    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) fail("cannot create private-state temporary file");
  pending_temporary = temporary;
  int succeeded = 0;
  if (fchmod(fd, 0600) != 0) goto cleanup;
  copy_fd(STDIN_FILENO, fd, limit);
  if (fsync(fd) != 0) goto cleanup;
  if (close(fd) != 0) { fd = -1; goto cleanup; }
  fd = -1;
  inspect_destination(name);
  if (renameat(directory_fd, temporary, directory_fd, name) != 0) goto cleanup;
  pending_temporary = NULL;
  if (fsync(directory_fd) != 0) goto cleanup;
  succeeded = 1;
cleanup:
  {
    int saved = errno;
    if (fd >= 0) close(fd);
    if (!succeeded) unlinkat(directory_fd, temporary, 0);
    errno = saved;
  }
  if (!succeeded) fail("atomic private-state write failed");
}

static void lock_file(const char *name) {
  validate_name(name);
  int lock_directory = openat(directory_fd, ".", O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  if (lock_directory < 0) fail("cannot open anchored directory for writer lock");
  if (flock(lock_directory, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) reject("writer lock is already held");
    fail("cannot lock anchored directory");
  }
  int fd = openat(directory_fd, name, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) fail("cannot open writer lock");
  struct stat state;
  if (fstat(fd, &state) != 0) fail("cannot inspect writer lock");
  validate_file(&state);
  if (state.st_nlink != 1) reject("writer lock must not be hard-linked");
  if (ftruncate(fd, 0) != 0
      || dprintf(fd, "pid=%ld\nhelper_pid=%ld\n", (long) getppid(), (long) getpid()) < 0
      || fsync(fd) != 0) {
    fail("cannot initialize writer lock");
  }
  if (close(fd) != 0) fail("cannot close writer-lock metadata");
  if (write(STDOUT_FILENO, "ready\n", 6) != 6) fail("cannot report writer lock readiness");
  char buffer[256];
  while (read(STDIN_FILENO, buffer, sizeof(buffer)) > 0) {}
  if (close(lock_directory) != 0) fail("cannot release writer lock");
}

int main(int argc, char **argv) {
  if (argc < 2) reject("operation is required");
  validate_directory();
  if (strcmp(argv[1], "read") == 0 && argc == 4) read_file(argv[2], argv[3]);
  else if (strcmp(argv[1], "write") == 0 && argc == 5) write_file(argv[2], argv[3], argv[4]);
  else if (strcmp(argv[1], "lock") == 0 && argc == 3) lock_file(argv[2]);
  else reject("invalid operation");
  return 0;
}
