#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <dirent.h>
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
#ifndef O_DIRECTORY
#error "anchored private state requires O_DIRECTORY"
#endif
#ifndef AT_EACCESS
#error "anchored private state requires effective-access checks"
#endif

#define PROTOCOL_MAGIC UINT32_C(0x41485053)
#define PROTOCOL_VERSION 1
#define HEADER_BYTES 32
#define MAX_NAME_BYTES 200
#define MAX_PAYLOAD_BYTES 1000000
#define TEMP_PREFIX ".agent-host-"
#define TEMP_SUFFIX ".tmp"

enum operation { OP_ACQUIRE = 1, OP_READ = 2, OP_WRITE = 3, OP_ASSERT = 4, OP_CLOSE = 5 };
enum error_code { ERR_NONE = 0, ERR_MISSING = 2, ERR_CONTENDED = 4 };

static int directory_fd = -1;
static int parent_fd = -1;
static struct stat directory_identity;
static char directory_name[NAME_MAX + 1];
static char pending_temporary[MAX_NAME_BYTES + 1];

static void cleanup_temporary(void) {
  if (directory_fd >= 0 && pending_temporary[0] != '\0') {
    unlinkat(directory_fd, pending_temporary, 0);
    pending_temporary[0] = '\0';
  }
}

static void fatal(const char *message) {
  int saved = errno;
  cleanup_temporary();
  errno = saved;
  fprintf(stderr, "anchored-private-state: %s", message);
  if (saved != 0) fprintf(stderr, ": %s", strerror(saved));
  fputc('\n', stderr);
  exit(1);
}

static void reject(const char *message) { errno = 0; fatal(message); }

static void read_exact(int fd, void *buffer, size_t length) {
  unsigned char *target = buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, target + offset, length - offset);
    if (count < 0) { if (errno == EINTR) continue; fatal("protocol read failed"); }
    if (count == 0) reject("truncated protocol frame");
    offset += (size_t)count;
  }
}

static void write_exact(int fd, const void *buffer, size_t length) {
  const unsigned char *source = buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, source + offset, length - offset);
    if (count < 0) { if (errno == EINTR) continue; fatal("protocol write failed"); }
    if (count == 0) reject("write made no progress");
    offset += (size_t)count;
  }
}

static uint16_t load_u16(const unsigned char *value) {
  uint16_t encoded; memcpy(&encoded, value, sizeof(encoded)); return ntohs(encoded);
}
static uint32_t load_u32(const unsigned char *value) {
  uint32_t encoded; memcpy(&encoded, value, sizeof(encoded)); return ntohl(encoded);
}
static void store_u16(unsigned char *target, uint16_t value) {
  uint16_t encoded = htons(value); memcpy(target, &encoded, sizeof(encoded));
}
static void store_u32(unsigned char *target, uint32_t value) {
  uint32_t encoded = htonl(value); memcpy(target, &encoded, sizeof(encoded));
}

static void response(uint16_t operation, uint32_t request_id, uint32_t error, uint32_t payload_length) {
  unsigned char header[HEADER_BYTES] = {0};
  store_u32(header, PROTOCOL_MAGIC);
  store_u16(header + 4, PROTOCOL_VERSION);
  store_u16(header + 6, (uint16_t)(operation | UINT16_C(0x8000)));
  store_u32(header + 8, request_id);
  store_u32(header + 20, payload_length);
  store_u32(header + 24, error);
  write_exact(STDOUT_FILENO, header, sizeof(header));
}

static int safe_name(const char *name, size_t length) {
  if (length == 0 || length > MAX_NAME_BYTES) return 0;
  if ((length == 1 && name[0] == '.') || (length == 2 && name[0] == '.' && name[1] == '.')) return 0;
  for (size_t index = 0; index < length; index += 1) {
    unsigned char c = (unsigned char)name[index];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '.' || c == '_' || c == '-')) return 0;
  }
  return 1;
}

static int safe_path_component(const char *name, size_t length) {
  return length > 0 && length <= NAME_MAX
    && !(length == 1 && name[0] == '.')
    && !(length == 2 && name[0] == '.' && name[1] == '.');
}

static void validate_private_file(const struct stat *state) {
  if (!S_ISREG(state->st_mode) || state->st_uid != geteuid() || (state->st_mode & 0777) != 0600
      || state->st_nlink != 1) reject("private state is not a single-link owner-only regular file");
}

static void validate_trusted_ancestor(int fd) {
  struct stat state;
  if (fstat(fd, &state) != 0) fatal("cannot inspect trusted ancestor");
  if (!S_ISDIR(state.st_mode) || state.st_uid != 0 || (state.st_mode & 022) != 0) {
    reject("state ancestor is not root-owned and non-writable");
  }
  errno = 0;
  if (faccessat(fd, ".", W_OK, AT_EACCESS) == 0) reject("state ancestor is writable by the effective user");
  if (errno != EACCES && errno != EPERM && errno != EROFS) fatal("cannot verify effective write access to state ancestor");
}

static void open_protected_directory(const char *configured) {
  char canonical[PATH_MAX];
  if (realpath(configured, canonical) == NULL) fatal("cannot resolve state directory");
  if (strcmp(configured, canonical) != 0 || canonical[0] != '/' || strcmp(canonical, "/") == 0) {
    reject("state directory must be an absolute canonical non-root path");
  }
  int current = open("/", O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  if (current < 0) fatal("cannot open filesystem root");
  validate_trusted_ancestor(current);
  char path[PATH_MAX];
  if (strlen(canonical) >= sizeof(path)) reject("state directory path is too long");
  strcpy(path, canonical + 1);
  char *save = NULL;
  char *component = strtok_r(path, "/", &save);
  while (component != NULL) {
    char *next = strtok_r(NULL, "/", &save);
    size_t length = strlen(component);
    if (!safe_path_component(component, length)) reject("state path contains an unsafe component");
    if (next == NULL) {
      struct stat entry;
      if (fstatat(current, component, &entry, AT_SYMLINK_NOFOLLOW) != 0) fatal("cannot inspect state directory entry");
      if (!S_ISDIR(entry.st_mode) || entry.st_uid != geteuid() || (entry.st_mode & 0777) != 0700) {
        reject("state directory must be current-user-owned mode 0700");
      }
      int opened = openat(current, component, O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
      if (opened < 0) fatal("cannot open state directory");
      parent_fd = current;
      directory_fd = opened;
      directory_identity = entry;
      strcpy(directory_name, component);
      return;
    }
    int opened = openat(current, component, O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    if (opened < 0) fatal("cannot open trusted ancestor");
    validate_trusted_ancestor(opened);
    close(current);
    current = opened;
    component = next;
  }
  reject("state directory path is invalid");
}

static void validate_current_path(void) {
  struct stat descriptor;
  struct stat entry;
  if (fstat(directory_fd, &descriptor) != 0
      || fstatat(parent_fd, directory_name, &entry, AT_SYMLINK_NOFOLLOW) != 0) {
    fatal("cannot verify current state directory");
  }
  if (!S_ISDIR(descriptor.st_mode) || !S_ISDIR(entry.st_mode)
      || descriptor.st_dev != directory_identity.st_dev || descriptor.st_ino != directory_identity.st_ino
      || entry.st_dev != directory_identity.st_dev || entry.st_ino != directory_identity.st_ino
      || descriptor.st_uid != geteuid() || (descriptor.st_mode & 0777) != 0700) {
    reject("state directory identity changed");
  }
}

static int temporary_name(const char *name) {
  size_t length = strlen(name), prefix = strlen(TEMP_PREFIX), suffix = strlen(TEMP_SUFFIX);
  return length > prefix + suffix && strncmp(name, TEMP_PREFIX, prefix) == 0
    && strcmp(name + length - suffix, TEMP_SUFFIX) == 0;
}

static void cleanup_crash_temporaries(void) {
  int duplicate = dup(directory_fd);
  if (duplicate < 0) fatal("cannot duplicate state directory");
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) fatal("cannot scan state directory");
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(directory);
    if (entry == NULL) {
      if (errno != 0) fatal("cannot scan state directory");
      break;
    }
    if (!temporary_name(entry->d_name)) continue;
    struct stat state;
    if (fstatat(directory_fd, entry->d_name, &state, AT_SYMLINK_NOFOLLOW) != 0) fatal("cannot inspect crash temporary");
    validate_private_file(&state);
    if (unlinkat(directory_fd, entry->d_name, 0) != 0) fatal("cannot remove crash temporary");
  }
  if (closedir(directory) != 0) fatal("cannot close state directory scan");
  if (fsync(directory_fd) != 0) fatal("cannot sync crash recovery");
}

static void inspect_destination(const char *name);

static void acquire_lock(const char *name, uint16_t operation, uint32_t request_id) {
  validate_current_path();
  if (flock(directory_fd, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) { response(operation, request_id, ERR_CONTENDED, 0); exit(1); }
    fatal("cannot lock state directory");
  }
  cleanup_crash_temporaries();
  char temporary[MAX_NAME_BYTES + 1];
  int length = snprintf(temporary, sizeof(temporary), ".agent-host-lock-%ld.tmp", (long)getpid());
  if (length < 0 || (size_t)length >= sizeof(temporary)) reject("cannot name writer-lock temporary");
  int fd = openat(directory_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) fatal("cannot create writer-lock metadata temporary");
  strcpy(pending_temporary, temporary);
  struct stat state;
  if (fstat(fd, &state) != 0) fatal("cannot inspect writer-lock metadata");
  validate_private_file(&state);
  if (dprintf(fd, "pid=%ld\nhelper_pid=%ld\n", (long)getppid(), (long)getpid()) < 0
      || fsync(fd) != 0 || close(fd) != 0) {
    fatal("cannot initialize writer-lock metadata");
  }
  validate_current_path();
  inspect_destination(name);
  if (renameat(directory_fd, temporary, directory_fd, name) != 0) fatal("cannot commit writer-lock metadata");
  pending_temporary[0] = '\0';
  if (fsync(directory_fd) != 0) fatal("cannot sync writer-lock metadata");
  response(operation, request_id, ERR_NONE, 0);
}

static void read_file(const char *name, uint32_t limit, uint16_t operation, uint32_t request_id) {
  validate_current_path();
  int fd = openat(directory_fd, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    if (errno == ENOENT) { response(operation, request_id, ERR_MISSING, 0); return; }
    fatal("cannot open private state");
  }
  struct stat state;
  if (fstat(fd, &state) != 0) fatal("cannot inspect private state");
  validate_private_file(&state);
  if (state.st_size < 0 || (uint64_t)state.st_size > limit || (uint64_t)state.st_size > MAX_PAYLOAD_BYTES) {
    reject("private state exceeds its size limit");
  }
  response(operation, request_id, ERR_NONE, (uint32_t)state.st_size);
  unsigned char buffer[16384];
  uint32_t remaining = (uint32_t)state.st_size;
  while (remaining > 0) {
    size_t wanted = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    ssize_t count = read(fd, buffer, wanted);
    if (count < 0) { if (errno == EINTR) continue; fatal("private-state read failed"); }
    if (count == 0) reject("private state changed during read");
    write_exact(STDOUT_FILENO, buffer, (size_t)count);
    remaining -= (uint32_t)count;
  }
  if (close(fd) != 0) fatal("cannot close private state");
}

static void inspect_destination(const char *name) {
  struct stat state;
  if (fstatat(directory_fd, name, &state, AT_SYMLINK_NOFOLLOW) == 0) { validate_private_file(&state); return; }
  if (errno != ENOENT) fatal("cannot inspect private-state destination");
}

static void write_file(const char *name, const char *temporary, uint32_t payload_length,
    uint16_t operation, uint32_t request_id) {
  validate_current_path();
  inspect_destination(name);
  int fd = openat(directory_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) fatal("cannot create private-state temporary");
  strcpy(pending_temporary, temporary);
  unsigned char buffer[16384];
  uint32_t remaining = payload_length;
  while (remaining > 0) {
    size_t wanted = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    read_exact(STDIN_FILENO, buffer, wanted);
    write_exact(fd, buffer, wanted);
    remaining -= (uint32_t)wanted;
  }
  if (fsync(fd) != 0 || close(fd) != 0) fatal("cannot sync private-state temporary");
  validate_current_path();
  inspect_destination(name);
  if (renameat(directory_fd, temporary, directory_fd, name) != 0) fatal("cannot commit private state");
  pending_temporary[0] = '\0';
  if (fsync(directory_fd) != 0) fatal("cannot sync private-state directory");
  response(operation, request_id, ERR_NONE, 0);
}

int main(int argc, char **argv) {
  if (geteuid() == 0) reject("root execution is unsupported for the same-UID threat model");
  if (argc != 3 || strcmp(argv[1], "serve") != 0) reject("usage: anchored-private-state serve /canonical/state-directory");
  open_protected_directory(argv[2]);
  int acquired = 0;
  for (;;) {
    unsigned char header[HEADER_BYTES];
    read_exact(STDIN_FILENO, header, sizeof(header));
    uint32_t magic = load_u32(header), request_id = load_u32(header + 8);
    uint16_t version = load_u16(header + 4), operation = load_u16(header + 6);
    uint32_t name_length = load_u32(header + 12), auxiliary_length = load_u32(header + 16);
    uint32_t payload_length = load_u32(header + 20), limit = load_u32(header + 24), reserved = load_u32(header + 28);
    if (magic != PROTOCOL_MAGIC || version != PROTOCOL_VERSION || request_id == 0 || reserved != 0
        || name_length > MAX_NAME_BYTES || auxiliary_length > MAX_NAME_BYTES
        || payload_length > MAX_PAYLOAD_BYTES || limit > MAX_PAYLOAD_BYTES) reject("invalid protocol frame");
    char name[MAX_NAME_BYTES + 1] = {0};
    char auxiliary[MAX_NAME_BYTES + 1] = {0};
    if (name_length > 0) read_exact(STDIN_FILENO, name, name_length);
    if (auxiliary_length > 0) read_exact(STDIN_FILENO, auxiliary, auxiliary_length);
    if ((name_length > 0 && !safe_name(name, name_length))
        || (auxiliary_length > 0 && !safe_name(auxiliary, auxiliary_length))) reject("invalid protocol basename");
    if (operation == OP_ACQUIRE && !acquired && name_length > 0 && !temporary_name(name)
        && auxiliary_length == 0 && payload_length == 0) {
      acquire_lock(name, operation, request_id); acquired = 1;
    } else if (operation == OP_READ && acquired && name_length > 0 && !temporary_name(name) && auxiliary_length == 0
        && payload_length == 0 && limit > 0) {
      read_file(name, limit, operation, request_id);
    } else if (operation == OP_WRITE && acquired && name_length > 0 && auxiliary_length > 0
        && !temporary_name(name) && temporary_name(auxiliary) && strcmp(name, auxiliary) != 0
        && limit == payload_length) {
      write_file(name, auxiliary, payload_length, operation, request_id);
    } else if (operation == OP_ASSERT && acquired && name_length == 0 && auxiliary_length == 0
        && payload_length == 0 && limit == 0) {
      validate_current_path(); response(operation, request_id, ERR_NONE, 0);
    } else if (operation == OP_CLOSE && acquired && name_length == 0 && auxiliary_length == 0
        && payload_length == 0 && limit == 0) {
      validate_current_path();
      if (flock(directory_fd, LOCK_UN) != 0) fatal("cannot unlock state directory");
      response(operation, request_id, ERR_NONE, 0); return 0;
    } else reject("invalid protocol operation");
  }
}
