import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILES = [".env.local", ".env"];

function parseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const match = trimmed.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
  );
  if (!match) {
    return undefined;
  }

  const [, key, rawValue] = match;
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

export function loadLocalEnv(cwd = process.cwd()) {
  for (const file of ENV_FILES) {
    const fullPath = path.join(cwd, file);
    if (!existsSync(fullPath)) {
      continue;
    }

    const contents = readFileSync(fullPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed || process.env[parsed.key] !== undefined) {
        continue;
      }
      process.env[parsed.key] = parsed.value;
    }
  }
}
