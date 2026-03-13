#!/usr/bin/env bun

/**
 * Validates Gherkin .feature files using the @cucumber/gherkin parser.
 *
 * Usage: bun validate.js <file1.feature> [file2.feature ...]
 * Output: JSON to stdout with structure:
 *   { valid: boolean, files: [{ path: string, valid: boolean, errors: string[] }] }
 * Exit code: 0 if all files valid, 1 if any errors
 */

import fs from "fs";
import {
  AstBuilder,
  GherkinClassicTokenMatcher,
  Parser,
} from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: bun validate.js <file1.feature> [file2.feature ...]");
  process.exit(2);
}

function createParser() {
  const newId = IdGenerator.uuid();
  const builder = new AstBuilder(newId);
  const matcher = new GherkinClassicTokenMatcher();
  return new Parser(builder, matcher);
}

const results = args.map((filePath) => {
  const fileResult = { path: filePath, valid: true, errors: [] };

  if (!fs.existsSync(filePath)) {
    fileResult.valid = false;
    fileResult.errors.push(`File not found: ${filePath}`);
    return fileResult;
  }

  if (!filePath.endsWith(".feature")) {
    fileResult.valid = false;
    fileResult.errors.push(`Not a .feature file: ${filePath}`);
    return fileResult;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    fileResult.valid = false;
    fileResult.errors.push(`Cannot read file: ${err.message}`);
    return fileResult;
  }

  if (content.trim().length === 0) {
    fileResult.valid = false;
    fileResult.errors.push("File is empty");
    return fileResult;
  }

  try {
    const parser = createParser();
    parser.parse(content);
  } catch (err) {
    fileResult.valid = false;
    const message = err.errors
      ? err.errors.map((e) => e.message).join("; ")
      : err.message;
    fileResult.errors.push(message);
  }

  return fileResult;
});

const allValid = results.every((r) => r.valid);
const output = { valid: allValid, files: results };

console.log(JSON.stringify(output, null, 2));
process.exit(allValid ? 0 : 1);
