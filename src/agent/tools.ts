import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "read",
    description:
      "Read a UTF-8 text file from the workspace. Output is line-numbered. Use offset/limit to paginate large files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to the file.",
        },
        offset: {
          type: "integer",
          description: "Zero-indexed line to start reading from.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to read. Defaults to 2000.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description:
      "Write the full contents of a file, overwriting if it exists. Creates parent directories by default. Prefer `edit` for small changes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        content: { type: "string", description: "Full file contents to write." },
        create_dirs: {
          type: "boolean",
          description: "Create parent directories if missing. Defaults true.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace `old_string` with `new_string` in an existing file. By default `old_string` must appear exactly once — provide more surrounding context to disambiguate, or set replace_all=true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        old_string: {
          type: "string",
          description: "Exact text to replace.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence instead of requiring uniqueness.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command via `bash -lc` inside the workspace root. Use for builds, tests, installs, git, formatters. Output is truncated at 200KB per stream.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeout_ms: {
          type: "integer",
          description:
            "Per-command timeout in milliseconds (default from ATELI_BASH_TIMEOUT_MS).",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents for a regex pattern. Uses ripgrep if available, falls back to grep. Returns `path:line:match` lines.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for." },
        path: {
          type: "string",
          description: "Workspace-relative path to search under. Defaults to '.'.",
        },
        glob: {
          type: "string",
          description: "Optional glob to restrict the search (e.g. '*.ts').",
        },
        case_insensitive: {
          type: "boolean",
          description: "Match case-insensitively. Default false.",
        },
        max_results: {
          type: "integer",
          description: "Max matching lines (default 200, hard cap 1000).",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern. Honors .gitignore at workspace root plus a sensible default exclude list (node_modules, .git, dist, etc).",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern matched against workspace-relative paths. Supports *, **, ?, [abc], {a,b}.",
        },
        path: {
          type: "string",
          description: "Subdirectory to search under. Defaults to '.'.",
        },
        max_results: {
          type: "integer",
          description: "Max paths returned (default 500, hard cap 2000).",
        },
      },
      required: ["pattern"],
    },
  },
];
