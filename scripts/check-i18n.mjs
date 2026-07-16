import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleNames = ["default.properties", "en.properties", "zh_CN.properties"];
const errors = [];

const relative = (file) => path.relative(rootDir, file).split(path.sep).join("/");
const report = (message) => errors.push(message);
const lineNumberAt = (source, index) => source.slice(0, index).split("\n").length;

function hasContinuation(line) {
  let slashCount = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function decodePropertyToken(value) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\f/g, "\f")
    .replace(/\\([ :=#!\\])/g, "$1");
}

function splitProperty(line) {
  let escaped = false;
  let separatorIndex = -1;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "=" || character === ":" || /\s/.test(character)) {
      separatorIndex = index;
      break;
    }
  }

  if (separatorIndex === -1) return [line, ""];

  const key = line.slice(0, separatorIndex);
  let valueIndex = separatorIndex;
  while (valueIndex < line.length && /\s/.test(line[valueIndex])) valueIndex += 1;
  if (line[valueIndex] === "=" || line[valueIndex] === ":") valueIndex += 1;
  while (valueIndex < line.length && /\s/.test(line[valueIndex])) valueIndex += 1;
  return [key, line.slice(valueIndex)];
}

function parseProperties(source, file) {
  const entries = new Map();
  const physicalLines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let logicalLine = "";
  let logicalStart = 1;

  const consume = () => {
    const trimmed = logicalLine.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return;

    const [rawKey, rawValue] = splitProperty(trimmed);
    const key = decodePropertyToken(rawKey);
    const value = decodePropertyToken(rawValue);

    if (!key) {
      report(`${relative(file)}:${logicalStart}: property key is empty`);
      return;
    }
    if (entries.has(key)) {
      report(
        `${relative(file)}:${logicalStart}: duplicate key "${key}" (first declared on line ${entries.get(key).line})`,
      );
      return;
    }
    if (!value.trim()) report(`${relative(file)}:${logicalStart}: value for "${key}" is empty`);
    entries.set(key, { value, line: logicalStart });
  };

  for (let index = 0; index < physicalLines.length; index += 1) {
    const physicalLine = physicalLines[index];
    if (!logicalLine) logicalStart = index + 1;
    const continued = hasContinuation(physicalLine);
    const part = continued ? physicalLine.slice(0, -1) : physicalLine;
    logicalLine += logicalLine ? part.trimStart() : part;
    if (continued) continue;
    consume();
    logicalLine = "";
  }

  if (logicalLine) consume();
  return entries;
}

function placeholderSet(value) {
  return new Set(Array.from(value.matchAll(/\{(\d+)\}/g), (match) => match[1]));
}

function formatSet(values) {
  return `{${Array.from(values).sort((left, right) => Number(left) - Number(right)).join(", ")}}`;
}

function sameSet(left, right) {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

async function listFiles(directory, extension) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(file, extension)));
    else if (entry.isFile() && file.endsWith(extension)) result.push(file);
  }
  return result.sort();
}

function maskRange(source, start, end) {
  const masked = source.slice(start, end).replace(/[^\n]/g, " ");
  return source.slice(0, start) + masked + source.slice(end);
}

function findClosingBrace(source, openingBrace) {
  let depth = 0;
  let state = "code";
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state !== "code") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "'") state = "single-quote";
    else if (character === '"') state = "double-quote";
    else if (character === "`") state = "template";
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function maskDefaultMessages(source, file) {
  const declaration = /\b(?:const|let|var)\s+defaultMessages\s*=\s*\{/g;
  let masked = source;
  let match;

  while ((match = declaration.exec(masked)) !== null) {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    const closingBrace = findClosingBrace(masked, openingBrace);
    if (closingBrace === -1) {
      report(`${relative(file)}:${lineNumberAt(masked, openingBrace)}: defaultMessages object is not closed`);
      break;
    }
    masked = maskRange(masked, match.index, closingBrace + 1);
    declaration.lastIndex = closingBrace + 1;
  }
  return masked;
}

function stripJsComments(source) {
  let result = "";
  let state = "code";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      } else result += " ";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        state = "code";
        index += 1;
      } else result += character === "\n" ? "\n" : " ";
      continue;
    }
    if (state !== "code") {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      result += "  ";
      state = "block-comment";
      index += 1;
    } else {
      result += character;
      if (character === "'") state = "single-quote";
      else if (character === '"') state = "double-quote";
      else if (character === "`") state = "template";
    }
  }
  return result;
}

const bundles = new Map();
for (const bundleName of bundleNames) {
  const file = path.join(rootDir, "i18n", bundleName);
  try {
    bundles.set(bundleName, parseProperties(await readFile(file, "utf8"), file));
  } catch (error) {
    if (error?.code === "ENOENT") report(`${relative(file)}: required translation bundle is missing`);
    else throw error;
  }
}

const defaultBundle = bundles.get("default.properties");
if (defaultBundle) {
  const defaultKeys = new Set(defaultBundle.keys());
  for (const bundleName of bundleNames.slice(1)) {
    const bundle = bundles.get(bundleName);
    if (!bundle) continue;
    const bundleKeys = new Set(bundle.keys());
    for (const key of defaultKeys) {
      if (!bundleKeys.has(key)) report(`i18n/${bundleName}: missing key "${key}"`);
    }
    for (const key of bundleKeys) {
      if (!defaultKeys.has(key)) report(`i18n/${bundleName}: extra key "${key}"`);
    }

    for (const [key, defaultEntry] of defaultBundle) {
      const localizedEntry = bundle.get(key);
      if (!localizedEntry) continue;
      const expected = placeholderSet(defaultEntry.value);
      const actual = placeholderSet(localizedEntry.value);
      if (!sameSet(expected, actual)) {
        report(
          `i18n/${bundleName}:${localizedEntry.line}: placeholder mismatch for "${key}"; ` +
            `default uses ${formatSet(expected)}, translation uses ${formatSet(actual)}`,
        );
      }
    }
  }
}

const htmlFiles = await listFiles(path.join(rootDir, "src"), ".html");
const templateReferences = [];
for (const file of htmlFiles) {
  const source = await readFile(file, "utf8");
  const patterns = [
    /#\{\s*([A-Za-z0-9_.-]+)/g,
    /#messages\.(?:msg|msgOrNull)\(\s*(['"])([^'"]+)\1/g,
  ];
  for (const [patternIndex, pattern] of patterns.entries()) {
    for (const match of source.matchAll(pattern)) {
      templateReferences.push({
        file,
        key: match[patternIndex === 0 ? 1 : 2],
        line: lineNumberAt(source, match.index),
      });
    }
  }
}

for (const reference of templateReferences) {
  for (const bundleName of bundleNames) {
    const bundle = bundles.get(bundleName);
    if (bundle && !bundle.has(reference.key)) {
      report(`${relative(reference.file)}:${reference.line}: "${reference.key}" is missing from i18n/${bundleName}`);
    }
  }
}

const mainFile = path.join(rootDir, "src", "js", "main.ts");
const mainSource = await readFile(mainFile, "utf8");
const fixedLocale = /Intl\.DateTimeFormat\s*\(\s*(['"])zh-CN\1/g;
for (const match of mainSource.matchAll(fixedLocale)) {
  report(`${relative(mainFile)}:${lineNumberAt(mainSource, match.index)}: Intl.DateTimeFormat must not fix the locale to zh-CN`);
}

const mainWithoutDefaults = stripJsComments(maskDefaultMessages(mainSource, mainFile));
const reportedChineseLines = new Set();
for (const match of mainWithoutDefaults.matchAll(/[\p{Script=Han}]/gu)) {
  const line = lineNumberAt(mainWithoutDefaults, match.index);
  if (reportedChineseLines.has(line)) continue;
  reportedChineseLines.add(line);
  const snippet = mainWithoutDefaults.split("\n")[line - 1].trim();
  report(`${relative(mainFile)}:${line}: Chinese user-facing text remains outside defaultMessages: ${snippet}`);
}

if (errors.length) {
  console.error(`i18n check failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `i18n check passed: ${defaultBundle?.size ?? 0} keys across ${bundleNames.length} bundles, ` +
      `${templateReferences.length} template references, and no leaked Chinese UI text in src/js/main.ts.`,
  );
}
