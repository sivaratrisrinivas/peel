import { unzipSync } from "fflate";

import {
  ENGINE_VERSION,
  MAX_WORKSHEET_COLUMNS,
  MAX_WORKSHEET_ROWS,
  type DependencyAnalysis,
  type EngineScanResult,
  type EngineVerifyResult,
  type Finding,
  type RepairAction,
  type RepairPlan,
} from "./contracts.js";
import { canonicalJson, sha256 } from "./identity.js";
import { surgicalZipRewrite } from "./ooxml.js";

const decoder = new TextDecoder();

interface SheetInfo {
  name: string;
  state: string;
  relationshipId: string;
  path: string;
}

interface CellInfo {
  reference: string;
  column: number;
  row: number;
}

interface PackageInspection {
  files: Record<string, Uint8Array>;
  sheets: SheetInfo[];
  findings: Finding[];
  profileAccepted: boolean;
  unknownMembers: string[];
  plan?: RepairPlan;
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const escaped = name.replace(":", "\\:");
  return attributes.match(new RegExp(`(?:^|\\s)${escaped}=["']([^"']*)["']`, "i"))?.[1];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/^\/+/, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function relationshipSource(path: string): string {
  if (path === "_rels/.rels") return "";
  const marker = "/_rels/";
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return "";
  return `${path.slice(0, markerIndex)}/${path.slice(markerIndex + marker.length).replace(/\.rels$/, "")}`;
}

function relationshipTarget(path: string, target: string): string {
  const source = relationshipSource(path);
  const directory = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  return normalizePath(target.startsWith("/") ? target : `${directory}/${target}`);
}

function relationshipEntries(files: Record<string, Uint8Array>): Array<{ source: string; target: string; type: string; member: string }> {
  const entries: Array<{ source: string; target: string; type: string; member: string }> = [];
  for (const [member, bytes] of Object.entries(files)) {
    if (!member.endsWith(".rels")) continue;
    const xml = decoder.decode(bytes);
    for (const match of xml.matchAll(new RegExp(`<${localElement("Relationship")}\\b([^>]*)\\/?>(?:<\\/${localElement("Relationship")}>)?`, "gi"))) {
      const attributes = match[1] ?? "";
      const target = xmlAttribute(attributes, "Target");
      if (!target || xmlAttribute(attributes, "TargetMode")?.toLowerCase() === "external") continue;
      entries.push({
        source: relationshipSource(member),
        target: relationshipTarget(member, target),
        type: xmlAttribute(attributes, "Type") ?? "",
        member,
      });
    }
  }
  return entries;
}

function workbookRelationshipMap(files: Record<string, Uint8Array>): Map<string, string> {
  const map = new Map<string, string>();
  const xml = decoder.decode(files["xl/_rels/workbook.xml.rels"] ?? new Uint8Array());
  for (const match of xml.matchAll(new RegExp(`<${localElement("Relationship")}\\b([^>]*)\\/?>(?:<\\/${localElement("Relationship")}>)?`, "gi"))) {
    const attributes = match[1] ?? "";
    const id = xmlAttribute(attributes, "Id");
    const target = xmlAttribute(attributes, "Target");
    if (id && target && xmlAttribute(attributes, "TargetMode")?.toLowerCase() !== "external") {
      map.set(id, relationshipTarget("xl/_rels/workbook.xml.rels", target));
    }
  }
  return map;
}

function workbookSheets(files: Record<string, Uint8Array>): SheetInfo[] {
  const workbook = decoder.decode(files["xl/workbook.xml"] ?? new Uint8Array());
  const relationships = workbookRelationshipMap(files);
  return Array.from(workbook.matchAll(new RegExp(`<${localElement("sheet")}\\b([^>]*)\\/?>(?:<\\/${localElement("sheet")}>)?`, "gi")), (match) => {
    const attributes = match[1] ?? "";
    const relationshipId = xmlAttribute(attributes, "r:id") ?? xmlAttribute(attributes, "id") ?? "";
    return {
      name: decodeXml(xmlAttribute(attributes, "name") ?? ""),
      state: xmlAttribute(attributes, "state")?.toLowerCase() ?? "visible",
      relationshipId,
      path: relationships.get(relationshipId) ?? "",
    };
  });
}

function allowedProfilePart(name: string): boolean {
  return (
    name === "[Content_Types].xml" ||
    name === "_rels/.rels" ||
    name === "docProps/app.xml" ||
    name === "docProps/core.xml" ||
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/styles.xml" ||
    name === "xl/sharedStrings.xml" ||
    name.startsWith("xl/worksheets/") && (name.endsWith(".xml") || name.endsWith(".rels")) ||
    name.startsWith("xl/theme/") && name.endsWith(".xml") ||
    name.startsWith("xl/tables/") && name.endsWith(".xml") ||
    name.startsWith("xl/drawings/") && (name.endsWith(".xml") || name.endsWith(".rels")) ||
    name.startsWith("xl/charts/") && name.endsWith(".xml") ||
    name.startsWith("xl/pivotTables/") && name.endsWith(".xml") ||
    name.startsWith("xl/pivotCache/") && name.endsWith(".xml") ||
    name.startsWith("xl/externalLinks/") && (name.endsWith(".xml") || name.endsWith(".rels")) ||
    name === "xl/connections.xml" ||
    name === "xl/vbaProject.bin"
  );
}

function xmlWellFormed(xml: string): boolean {
  const source = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const stack: string[] = [];
  let roots = 0;
  let cursor = 0;
  const tags = /<\/?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s[^<>]*?)?\/?>/g;
  for (const match of source.matchAll(tags)) {
    const text = source.slice(cursor, match.index);
    if (stack.length === 0 ? text.trim().length > 0 : text.includes("<") || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) return false;
    const full = match[0] ?? "";
    const name = match[1]!.toLowerCase();
    const body = full.slice(full.startsWith("</") ? 2 : 1, full.endsWith("/>") ? -2 : -1).trim();
    const attributes = body.slice(match[1]!.length);
    if (full.startsWith("</")) {
      if (attributes.trim().length > 0) return false;
    } else {
      const attributePattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
      let attributeCursor = 0;
      const attributeNames = new Set<string>();
      for (const attribute of attributes.matchAll(attributePattern)) {
        if (attributes.slice(attributeCursor, attribute.index).trim().length > 0) return false;
        if (attributeNames.has(attribute[1]!)) return false;
        attributeNames.add(attribute[1]!);
        attributeCursor = (attribute.index ?? 0) + attribute[0].length;
      }
      if (attributes.slice(attributeCursor).trim().length > 0) return false;
    }
    if (full.startsWith("</")) {
      if (stack.pop() !== name) return false;
    } else {
      if (stack.length === 0 && ++roots > 1) return false;
      if (!/\/\s*>$/.test(full)) stack.push(name);
    }
    cursor = (match.index ?? 0) + full.length;
  }
  const trailing = source.slice(cursor);
  return stack.length === 0 && roots === 1 && trailing.trim().length === 0 && /<[A-Za-z_]/.test(source);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function localElement(element: string): string {
  return `(?:[A-Za-z_][\\w.-]*:)?(?:${element})`;
}

function cellColumn(column: string): number {
  let result = 0;
  for (const character of column.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function cellInfo(reference: string): CellInfo | undefined {
  const match = reference.match(/^\$?([A-Z]{1,3})\$?([1-9][0-9]*)$/i);
  if (!match) return undefined;
  const column = cellColumn(match[1]!);
  const row = Number(match[2]);
  return Number.isSafeInteger(row) && row <= MAX_WORKSHEET_ROWS && column > 0 && column <= MAX_WORKSHEET_COLUMNS
    ? { reference: `${match[1]!.toUpperCase()}${row}`, column, row }
    : undefined;
}

function hiddenDimensionRanges(xml: string): { rows: Set<number>; columns: Array<[number, number]> } {
  const rows = new Set<number>();
  for (const match of xml.matchAll(new RegExp(`<${localElement("row")}\\b([^>]*)\\/?>(?:<\\/${localElement("row")}>)?`, "gi"))) {
    const attributes = match[1] ?? "";
    if (!/(?:^|\s)hidden=["'](?:1|true)["']/i.test(attributes)) continue;
    const row = Number(xmlAttribute(attributes, "r"));
    if (Number.isSafeInteger(row) && row > 0) rows.add(row);
  }
  const columns: Array<[number, number]> = [];
  for (const match of xml.matchAll(new RegExp(`<${localElement("col")}\\b([^>]*)\\/?>(?:<\\/${localElement("col")}>)?`, "gi"))) {
    const attributes = match[1] ?? "";
    if (!/(?:^|\s)hidden=["'](?:1|true)["']/i.test(attributes)) continue;
    const minimum = Number(xmlAttribute(attributes, "min"));
    const maximum = Number(xmlAttribute(attributes, "max"));
    if (Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum > 0 && maximum >= minimum) {
      columns.push([minimum, maximum]);
    }
  }
  return { rows, columns };
}

function cellHasValue(content: string): boolean {
  return new RegExp(`<${localElement("f|v|is")}\\b`, "i").test(content);
}

function concealedCellSummary(xml: string): { cells: CellInfo[]; unresolved: number } {
  const dimensions = hiddenDimensionRanges(xml);
  const cells: CellInfo[] = [];
  let unresolved = 0;
  const rowPattern = new RegExp(`<${localElement("row")}\\b([^>]*)>([\\s\\S]*?)</${localElement("row")}>`, "gi");
  const cellPattern = new RegExp(`<${localElement("c")}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)</${localElement("c")}>)`, "gi");
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const rowAttributes = rowMatch[1] ?? "";
    const rowHidden = /(?:^|\s)hidden=["'](?:1|true)["']/i.test(rowAttributes);
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(cellPattern)) {
      if (!cellHasValue(cellMatch[2] ?? "")) continue;
      const reference = cellInfo(xmlAttribute(cellMatch[1] ?? "", "r") ?? "");
      const hiddenColumn = reference !== undefined && dimensions.columns.some(([minimum, maximum]) => reference.column >= minimum && reference.column <= maximum);
      if (!rowHidden && !hiddenColumn && !(reference === undefined && dimensions.columns.length > 0)) continue;
      if (reference === undefined) unresolved += 1;
      else cells.push(reference);
    }
  }
  return { cells: cells.sort((left, right) => left.row - right.row || left.column - right.column), unresolved };
}

function concealedCells(xml: string): CellInfo[] {
  return concealedCellSummary(xml).cells;
}

function unresolvedConcealedValues(xml: string): number {
  return concealedCellSummary(xml).unresolved;
}

function sharedStringCells(xml: string, cells: readonly string[]): string[] {
  const targets = new Set(cells.map((reference) => cellInfo(reference)?.reference).filter((reference): reference is string => reference !== undefined));
  return Array.from(xml.matchAll(new RegExp(`<${localElement("c")}\\b([^>]*?)(?:\\/>|>[\\s\\S]*?<\\/${localElement("c")}>)`, "gi")))
    .filter((match) => xmlAttribute(match[1] ?? "", "t")?.toLowerCase() === "s")
    .map((match) => cellInfo(xmlAttribute(match[1] ?? "", "r") ?? "")?.reference)
    .filter((reference): reference is string => reference !== undefined && targets.has(reference));
}

function concealedCellsByWorksheet(files: Record<string, Uint8Array>, sheets: readonly SheetInfo[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const sheet of sheets) {
    if (!sheet.path || !files[sheet.path]) continue;
    const cells = concealedCells(decoder.decode(files[sheet.path]!)).map((cell) => cell.reference);
    if (cells.length > 0) result[sheet.path] = cells;
  }
  return result;
}

function unresolvedConcealedValuesByWorksheet(files: Record<string, Uint8Array>, sheets: readonly SheetInfo[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const sheet of sheets) {
    if (!sheet.path || !files[sheet.path]) continue;
    const count = unresolvedConcealedValues(decoder.decode(files[sheet.path]!));
    if (count > 0) result[sheet.path] = count;
  }
  return result;
}

function cellInRange(reference: CellInfo, start: CellInfo, end: CellInfo): boolean {
  return reference.row >= Math.min(start.row, end.row) && reference.row <= Math.max(start.row, end.row) &&
    reference.column >= Math.min(start.column, end.column) && reference.column <= Math.max(start.column, end.column);
}

function columnRangeContainsTargets(targets: readonly CellInfo[], start: string, end: string): boolean {
  const minimum = cellColumn(start);
  const maximum = cellColumn(end);
  return targets.some((target) => target.column >= Math.min(minimum, maximum) && target.column <= Math.max(minimum, maximum));
}

function rowRangeContainsTargets(targets: readonly CellInfo[], start: string, end: string): boolean {
  const minimum = Number(start);
  const maximum = Number(end);
  return targets.some((target) => target.row >= Math.min(minimum, maximum) && target.row <= Math.max(minimum, maximum));
}

function normalizedSheetName(name: string): string {
  return name.replace(/''/g, "'").trim().toLowerCase();
}

function sheetInSpan(
  sheet: SheetInfo,
  first: string,
  last: string,
  sheetOrder: readonly SheetInfo[],
): boolean {
  const targetIndex = sheetOrder.findIndex((candidate) => normalizedSheetName(candidate.name) === normalizedSheetName(sheet.name));
  const firstIndex = sheetOrder.findIndex((candidate) => normalizedSheetName(candidate.name) === normalizedSheetName(first));
  const lastIndex = sheetOrder.findIndex((candidate) => normalizedSheetName(candidate.name) === normalizedSheetName(last));
  if (targetIndex >= 0 && firstIndex >= 0 && lastIndex >= 0) {
    return targetIndex >= Math.min(firstIndex, lastIndex) && targetIndex <= Math.max(firstIndex, lastIndex);
  }
  return normalizedSheetName(first) === normalizedSheetName(sheet.name) || normalizedSheetName(last) === normalizedSheetName(sheet.name);
}

function referencesCells(
  text: string,
  sheet: SheetInfo,
  cells: readonly string[],
  currentSheetPath?: string,
  allowUnqualifiedWhenUnknownSheet = false,
  sheetOrder: readonly SheetInfo[] = [],
): boolean {
  if (cells.length === 0) return false;
  const decoded = decodeXml(text);
  const targets = cells.map(cellInfo).filter((cell): cell is CellInfo => cell !== undefined);
  const sheetMatches = (match: RegExpMatchArray): boolean => {
    const referencedSheet = match[1] !== undefined ? match[1]!.replace(/''/g, "'") : match[2];
    return Boolean(referencedSheet && referencedSheet.trim().toLowerCase() === sheet.name.toLowerCase());
  };
  const referencePattern = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w .-]*))!\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?/gi;
  for (const match of decoded.matchAll(referencePattern)) {
    if (!sheetMatches(match)) continue;
    const start = cellInfo(`${match[3]}${match[4]}`);
    const end = cellInfo(`${match[5] ?? match[3]}${match[6] ?? match[4]}`);
    if (start && end && targets.some((target) => cellInRange(target, start, end))) return true;
  }
  const quotedThreeDimensionalPattern = /'((?:[^']|'')+)'!\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?/gi;
  for (const match of decoded.matchAll(quotedThreeDimensionalPattern)) {
    const names = (match[1] ?? "").split(":");
    if (names.length !== 2 || !sheetInSpan(sheet, names[0]!, names[1]!, sheetOrder)) continue;
    const start = cellInfo(`${match[2]}${match[3]}`);
    const end = cellInfo(`${match[4] ?? match[2]}${match[5] ?? match[3]}`);
    if (start && end && targets.some((target) => cellInRange(target, start, end))) return true;
  }
  const threeDimensionalPattern = /([A-Za-z_][\w .-]*)\s*:\s*([A-Za-z_][\w .-]*)!\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?/gi;
  for (const match of decoded.matchAll(threeDimensionalPattern)) {
    if (!sheetInSpan(sheet, match[1]!, match[2]!, sheetOrder)) continue;
    const start = cellInfo(`${match[3]}${match[4]}`);
    const end = cellInfo(`${match[5] ?? match[3]}${match[6] ?? match[4]}`);
    if (start && end && targets.some((target) => cellInRange(target, start, end))) return true;
  }
  const qualifiedColumnPattern = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w .-]*))!\$?([A-Z]{1,3}):\$?([A-Z]{1,3})/gi;
  for (const match of decoded.matchAll(qualifiedColumnPattern)) {
    if (sheetMatches(match) && columnRangeContainsTargets(targets, match[3]!, match[4]!)) return true;
  }
  const qualifiedRowPattern = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w .-]*))!\$?([1-9][0-9]*):\$?([1-9][0-9]*)/gi;
  for (const match of decoded.matchAll(qualifiedRowPattern)) {
    if (sheetMatches(match) && rowRangeContainsTargets(targets, match[3]!, match[4]!)) return true;
  }
  if (currentSheetPath !== sheet.path && !allowUnqualifiedWhenUnknownSheet) return false;
  const localPattern = /(?:^|[^A-Za-z0-9_])\$?([A-Z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Z]{1,3})\$?([1-9][0-9]*))?(?![A-Za-z0-9_])/gi;
  for (const match of decoded.matchAll(localPattern)) {
    const start = cellInfo(`${match[1]}${match[2]}`);
    const end = cellInfo(`${match[3] ?? match[1]}${match[4] ?? match[2]}`);
    if (start && end && targets.some((target) => cellInRange(target, start, end))) return true;
  }
  const localColumnPattern = /(?:^|[^A-Za-z0-9_])\$?([A-Z]{1,3}):\$?([A-Z]{1,3})(?![A-Za-z0-9_])/gi;
  for (const match of decoded.matchAll(localColumnPattern)) {
    if (columnRangeContainsTargets(targets, match[1]!, match[2]!)) return true;
  }
  const localRowPattern = /(?:^|[^A-Za-z0-9_])\$?([1-9][0-9]*):\$?([1-9][0-9]*)(?![A-Za-z0-9_])/gi;
  for (const match of decoded.matchAll(localRowPattern)) {
    if (rowRangeContainsTargets(targets, match[1]!, match[2]!)) return true;
  }
  return false;
}

function includesSheetReference(xml: string, sheet: SheetInfo): boolean {
  if (sheet.name.length === 0) return false;
  xml = decodeXml(xml);
  const name = sheet.name.replace(/'/g, "''");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:'${escaped}'|${escaped})!`, "i").test(xml) ||
    new RegExp(`(?:^|\\s)sheet=["']'?${escaped}'?["']`, "i").test(xml) ||
    (sheet.path.length > 0 && xml.includes(sheet.path));
}

function matchingElements(xml: string, element: string, sheet: SheetInfo): boolean {
  for (const match of xml.matchAll(new RegExp(`<${localElement(element)}\\b[^>]*>([\\s\\S]*?)</${localElement(element)}>`, "gi"))) {
    if (includesSheetReference(match[0] ?? "", sheet)) return true;
  }
  return false;
}

function matchingElementsForCells(
  xml: string,
  element: string,
  sheet: SheetInfo,
  cells: readonly string[],
  currentSheetPath?: string,
  allowUnqualifiedWhenUnknownSheet = false,
  sheetOrder: readonly SheetInfo[] = [],
): boolean {
  const pattern = "<" + localElement(element) + "\\b[^>]*(?:/>|>[\\s\\S]*?</" + localElement(element) + ">)";
  for (const match of xml.matchAll(new RegExp(pattern, "gi"))) {
    const elementXml = match[0] ?? "";
    if (element.toLowerCase() === "definedname") {
      const attributes = elementXml.match(new RegExp("<" + localElement(element) + "\\b([^>]*)", "i"))?.[1] ?? "";
      const localSheetId = xmlAttribute(attributes, "localSheetId");
      if (localSheetId !== undefined) {
        const index = Number(localSheetId);
        if (!Number.isInteger(index) || index < 0 || !sheetOrder[index]) return true;
        if (sheetOrder[index]!.path !== sheet.path) continue;
        if (referencesCells(elementXml, sheet, cells, sheet.path, false, sheetOrder)) return true;
      } else if (referencesCells(elementXml, sheet, cells, undefined, true, sheetOrder)) {
        // Workbook-scoped relative names have no owning worksheet. Refuse
        // conservatively whenever their coordinates could name a target.
        return true;
      }
      continue;
    }
    if (referencesCells(elementXml, sheet, cells, currentSheetPath, allowUnqualifiedWhenUnknownSheet, sheetOrder)) return true;
  }
  return false;
}

function relationshipPathToWorksheet(
  member: string,
  worksheet: string,
  relationships: readonly { source: string; target: string; member: string }[],
): string[] | undefined {
  if (member === worksheet) return [];
  let current = member;
  const seen = new Set<string>();
  const path: string[] = [];
  while (!seen.has(current)) {
    seen.add(current);
    const relation = relationships.find((candidate) => candidate.target === current);
    if (!relation) return undefined;
    path.push(relation.member);
    if (relation.source === worksheet) return path;
    current = relation.source;
  }
  return undefined;
}

function memberIsRelatedToWorksheet(
  member: string,
  worksheet: string,
  relationships: readonly { source: string; target: string; member: string }[],
): boolean {
  return relationshipPathToWorksheet(member, worksheet, relationships) !== undefined;
}

function hasMacro(files: Record<string, Uint8Array>): boolean {
  return Object.keys(files).some((name) => /vbaProject\.bin$/i.test(name)) ||
    decoder.decode(files["[Content_Types].xml"] ?? new Uint8Array()).includes("macroEnabled");
}

function hasExternalConnection(files: Record<string, Uint8Array>): boolean {
  return Object.keys(files).some((name) => name === "xl/connections.xml" || name.startsWith("xl/externalLinks/"));
}

function emptyDependencies(): DependencyAnalysis {
  return {
    visible_formulas: [],
    defined_names: [],
    data_validation: [],
    tables: [],
    charts: [],
    pivots: [],
    package_relationships: [],
    macros: [],
    external_connections: [],
  };
}

function worksheetRelationshipMember(path: string): string {
  const separator = path.lastIndexOf("/");
  const directory = separator < 0 ? "" : `${path.slice(0, separator + 1)}`;
  const filename = path.slice(separator + 1);
  return `${directory}_rels/${filename}.rels`;
}

function actionFor(sheet: SheetInfo, files: Record<string, Uint8Array>): RepairAction {
  const target = sheet.path;
  const relationshipPart = worksheetRelationshipMember(target);
  const changed = unique([
    ...(hasContentTypeOverride(files, target) ? ["[Content_Types].xml"] : []),
    "xl/_rels/workbook.xml.rels",
    "xl/workbook.xml",
    target,
    ...(files[relationshipPart] ? [relationshipPart] : []),
  ]);
  return {
    kind: "delete_hidden_worksheet",
    worksheet: sheet.name,
    target_member: target,
    changed_members: changed,
    capability_losses: [
      `The hidden worksheet ${sheet.name}, its cells, hidden state, row and column metadata, and sheet-local formatting will be removed.`,
      "No visible formulas, defined names, data validation, tables, charts, pivots, package relationships, macros, or external connections reference this worksheet; none of those capabilities are changed by this plan.",
      "The structural Repair does not recalculate workbook formulas or cached values after the worksheet is removed.",
    ],
  };
}

function clearActionFor(sheet: SheetInfo, cells: readonly string[]): RepairAction {
  return {
    kind: "clear_hidden_cell_values",
    worksheet: sheet.name,
    target_member: sheet.path,
    cell_references: [...cells],
    changed_members: [sheet.path],
    capability_losses: [
      "The concealed values in worksheet " + sheet.name + " at " + cells.join(", ") + " will be cleared.",
      "The hidden row and column dimensions, cell formatting, formulas outside these cells, and unrelated package members are preserved.",
      "The cleared values cannot be restored from the repaired artifact; the original Artifact Reference remains unchanged.",
    ],
  };
}

function hasContentTypeOverride(files: Record<string, Uint8Array>, target: string): boolean {
  const xml = decoder.decode(files["[Content_Types].xml"] ?? new Uint8Array());
  for (const match of xml.matchAll(new RegExp(`<${localElement("Override")}\\b([^>]*)\\/?>(?:<\\/${localElement("Override")}>)?`, "gi"))) {
    const partName = xmlAttribute(match[1] ?? "", "PartName");
    if (partName !== undefined && normalizePath(partName) === target) return true;
  }
  return false;
}

function buildPlan(
  files: Record<string, Uint8Array>,
  sheets: readonly SheetInfo[],
  findings: readonly Finding[],
  artifactSha256: string,
  engineVersion: string,
  unknownMembers: readonly string[],
  unresolvedByWorksheet: Record<string, number>,
): RepairPlan | undefined {
  const hidden = sheets.filter((sheet) => sheet.state === "hidden" || sheet.state === "veryhidden");
  const concealedByWorksheet = concealedCellsByWorksheet(files, sheets);
  if (hidden.length === 0 && Object.keys(concealedByWorksheet).length === 0 && Object.keys(unresolvedByWorksheet).length === 0) return undefined;
  const relationships = relationshipEntries(files);
  const dependencies = emptyDependencies();
  const reasons: string[] = [];
  const actions: RepairAction[] = [];
  const visibleSheetPaths = new Set(
    sheets
      .filter((candidate) => candidate.state !== "hidden" && candidate.state !== "veryhidden")
      .map((candidate) => candidate.path),
  );
  for (const sheet of sheets) {
    if (!sheet.path || !sheet.path.startsWith("xl/worksheets/") || !sheet.path.endsWith(".xml") || !files[sheet.path]) {
      reasons.push(`Worksheet ${sheet.name} has no valid worksheet package member.`);
    }
  }
  const macro = hasMacro(files);
  const external = hasExternalConnection(files);
  if (macro) dependencies.macros.push("[Content_Types].xml/vbaProject.bin");
  if (external) dependencies.external_connections.push(...Object.keys(files).filter((name) => name === "xl/connections.xml" || name.startsWith("xl/externalLinks/")));
  if (unknownMembers.length > 0) reasons.push(`Unsupported content-bearing package members: ${unknownMembers.join(", ")}`);
  if (macro) reasons.push("Macros are present and cannot be preserved by this Repair.");
  if (external) reasons.push("External connections are present and cannot be proven safe by this Repair.");
  if (findings.some((finding) => !["hidden_worksheet", "hidden_row_or_column"].includes(finding.mechanism))) {
    reasons.push("The complete plan contains a concealed mechanism that this Repair does not transform.");
  }

  for (const sheet of hidden) {
    if (!sheet.path || !sheet.path.startsWith("xl/worksheets/") || !sheet.path.endsWith(".xml") || !files[sheet.path]) {
      reasons.push(`The hidden worksheet ${sheet.name} has no resolvable package relationship.`);
      continue;
    }
    const sheetDependencies: string[] = [];
    for (const [member, bytes] of Object.entries(files)) {
      const xml = decoder.decode(bytes);
      if (visibleSheetPaths.has(member) && matchingElements(xml, "f", sheet)) {
        dependencies.visible_formulas.push(member);
        sheetDependencies.push(`visible formula in ${member}`);
      }
      if (member === "xl/workbook.xml" && matchingElements(xml, "definedName", sheet)) {
        dependencies.defined_names.push(member);
        sheetDependencies.push("defined name in xl/workbook.xml");
      }
      if (visibleSheetPaths.has(member) && matchingElements(xml, "dataValidation", sheet)) {
        dependencies.data_validation.push(member);
        sheetDependencies.push(`data validation in ${member}`);
      }
      if (member.startsWith("xl/tables/") && member.endsWith(".xml") && includesSheetReference(xml, sheet)) {
        dependencies.tables.push(member);
        sheetDependencies.push(`table in ${member}`);
      }
      if ((member.startsWith("xl/charts/") || member.startsWith("xl/drawings/")) && member.endsWith(".xml") && includesSheetReference(xml, sheet)) {
        dependencies.charts.push(member);
        sheetDependencies.push(`chart or drawing in ${member}`);
      }
      if (member.startsWith("xl/pivot") && member.endsWith(".xml") && includesSheetReference(xml, sheet)) {
        dependencies.pivots.push(member);
        sheetDependencies.push(`pivot in ${member}`);
      }
    }
    for (const relation of relationships) {
      if (relation.target === sheet.path && relation.source !== "xl/workbook.xml") {
        dependencies.package_relationships.push(relation.member);
        sheetDependencies.push(`package relationship in ${relation.member}`);
      }
      if (relation.source === sheet.path) {
        dependencies.package_relationships.push(relation.member);
        if (relation.type.toLowerCase().includes("table")) {
          dependencies.tables.push(relation.target);
          sheetDependencies.push(`table relationship in ${relation.member}`);
        } else if (relation.type.toLowerCase().includes("chart") || relation.type.toLowerCase().includes("drawing")) {
          dependencies.charts.push(relation.target);
          sheetDependencies.push(`chart relationship in ${relation.member}`);
        } else if (relation.type.toLowerCase().includes("pivot")) {
          dependencies.pivots.push(relation.target);
          sheetDependencies.push(`pivot relationship in ${relation.member}`);
        } else {
          sheetDependencies.push(`package relationship in ${relation.member}`);
        }
      }
    }
    if (sheetDependencies.length > 0) {
      reasons.push(`Hidden worksheet ${sheet.name} has dependencies: ${unique(sheetDependencies).join(", ")}.`);
    } else {
      actions.push(actionFor(sheet, files));
    }
  }

  for (const sheet of sheets.filter((candidate) => candidate.state !== "hidden" && candidate.state !== "veryhidden")) {
    const cells = concealedByWorksheet[sheet.path] ?? [];
    const unresolvedCount = unresolvedByWorksheet[sheet.path] ?? 0;
    if (cells.length === 0 && unresolvedCount === 0) continue;
    const sheetDependencies: string[] = [];
    const dependentMembers = new Set<string>();
    if (unresolvedCount > 0) sheetDependencies.push(`${unresolvedCount} concealed value(s) without an exact cell reference`);
    const sharedCellReferences = sharedStringCells(decoder.decode(files[sheet.path] ?? new Uint8Array()), cells);
    if (sharedCellReferences.length > 0) sheetDependencies.push("shared-string value in xl/sharedStrings.xml");
    for (const [member, bytes] of Object.entries(files)) {
      const xml = decoder.decode(bytes);
      const relatedToSheet = member === sheet.path || memberIsRelatedToWorksheet(member, sheet.path, relationships);
      if (visibleSheetPaths.has(member) && matchingElementsForCells(xml, "f", sheet, cells, member, false, sheets)) {
        dependencies.visible_formulas.push(member);
        dependentMembers.add(member);
        sheetDependencies.push("visible formula in " + member);
      }
      if (member === "xl/workbook.xml" && matchingElementsForCells(xml, "definedName", sheet, cells, undefined, false, sheets)) {
        dependencies.defined_names.push(member);
        dependentMembers.add(member);
        sheetDependencies.push("defined name in xl/workbook.xml");
      }
      if (visibleSheetPaths.has(member) && matchingElementsForCells(xml, "dataValidation", sheet, cells, member, false, sheets)) {
        dependencies.data_validation.push(member);
        dependentMembers.add(member);
        sheetDependencies.push("data validation in " + member);
      }
      if (member.startsWith("xl/tables/") && member.endsWith(".xml") &&
        referencesCells(xml, sheet, cells, relatedToSheet ? sheet.path : undefined, false, sheets)) {
        dependencies.tables.push(member);
        dependentMembers.add(member);
        sheetDependencies.push("table in " + member);
      }
      if ((member.startsWith("xl/charts/") || member.startsWith("xl/drawings/")) && member.endsWith(".xml") &&
        referencesCells(xml, sheet, cells, relatedToSheet ? sheet.path : undefined, false, sheets)) {
        dependencies.charts.push(member);
        dependentMembers.add(member);
        sheetDependencies.push("chart or drawing in " + member);
      }
      if (member.startsWith("xl/pivot") && member.endsWith(".xml") &&
        referencesCells(xml, sheet, cells, relatedToSheet ? sheet.path : undefined, false, sheets)) {
        dependencies.pivots.push(member);
        dependentMembers.add(member);
        sheetDependencies.push("pivot in " + member);
      }
    }
    for (const dependentMember of dependentMembers) {
      const path = relationshipPathToWorksheet(dependentMember, sheet.path, relationships) ?? [];
      for (const relationMember of path) {
        dependencies.package_relationships.push(relationMember);
        sheetDependencies.push("package relationship in " + relationMember);
      }
    }
    if (sheetDependencies.length > 0) {
      reasons.push("Concealed values in worksheet " + sheet.name + " have dependencies: " + unique(sheetDependencies).join(", ") + ".");
    } else {
      actions.push(clearActionFor(sheet, cells));
    }
  }

  const plan: RepairPlan = {
    version: "1",
    operation: "repair_plan",
    status: reasons.length === 0 && actions.length > 0 ? "eligible" : "refused",
    artifact_sha256: artifactSha256,
    engine_version: engineVersion,
    dependency_analysis: {
      visible_formulas: unique(dependencies.visible_formulas),
      defined_names: unique(dependencies.defined_names),
      data_validation: unique(dependencies.data_validation),
      tables: unique(dependencies.tables),
      charts: unique(dependencies.charts),
      pivots: unique(dependencies.pivots),
      package_relationships: unique(dependencies.package_relationships),
      macros: unique(dependencies.macros),
      external_connections: unique(dependencies.external_connections),
    },
    actions: reasons.length === 0 ? actions : [],
    changed_members: reasons.length === 0 ? unique(actions.flatMap((action) => action.changed_members)) : [],
    capability_losses: unique([
      ...actions.flatMap((action) => action.capability_losses),
      ...reasons,
    ]),
  };
  if (reasons.length > 0) plan.refusal_reasons = unique(reasons);
  return plan;
}

function inspectPackage(bytes: Uint8Array, artifactSha256: string, engineVersion: string = ENGINE_VERSION): PackageInspection {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { files: {}, sheets: [], findings: [], profileAccepted: false, unknownMembers: [] };
  }
  const unknownMembers = Object.keys(files).filter((name) => !allowedProfilePart(name));
  const malformedXml = Object.entries(files).some(([name, bytes]) =>
    (name.endsWith(".xml") || name.endsWith(".rels")) && !xmlWellFormed(decoder.decode(bytes)));
  const workbook = files["xl/workbook.xml"];
  const contentTypes = files["[Content_Types].xml"];
  const profileAccepted = Boolean(
    workbook && contentTypes && files["xl/worksheets/sheet1.xml"] &&
    decoder.decode(contentTypes).includes("spreadsheetml.sheet.main+xml") &&
    unknownMembers.length === 0 &&
    !malformedXml,
  );
  if (!profileAccepted) return { files, sheets: workbook ? workbookSheets(files) : [], findings: [], profileAccepted: false, unknownMembers };
  const sheets = workbookSheets(files);
  const findings: Finding[] = [];
  const hiddenSheets = sheets.filter((sheet) => sheet.state === "hidden" || sheet.state === "veryhidden");
  if (hiddenSheets.length > 0) findings.push({ mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: hiddenSheets.length });
  const concealed = concealedCellsByWorksheet(files, sheets);
  const unresolved = unresolvedConcealedValuesByWorksheet(files, sheets);
  const concealedValueCount = Object.values(concealed).reduce((count, cells) => count + cells.length, 0) + Object.values(unresolved).reduce((count, value) => count + value, 0);
  if (concealedValueCount > 0) findings.push({ mechanism: "hidden_row_or_column", location: "xl/worksheets", count: concealedValueCount });
  const plan = buildPlan(files, sheets, findings, artifactSha256, engineVersion, unknownMembers, unresolved);
  return { files, sheets, findings, profileAccepted, unknownMembers, ...(plan ? { plan } : {}) };
}

export function scanWorkbook(bytes: Uint8Array, artifactSha256: string): EngineScanResult {
  const inspection = inspectPackage(bytes, artifactSha256);
  if (!inspection.profileAccepted) {
    return {
      version: "1",
      operation: "scan",
      status: "refused",
      artifact_sha256: artifactSha256,
      engine_version: ENGINE_VERSION,
      supported_profile: "refused",
      findings: inspection.findings,
      refusal_code: "unsupported_content",
    };
  }
  return {
    version: "1",
    operation: "scan",
    status: inspection.findings.length === 0 ? "clean" : "findings",
    artifact_sha256: artifactSha256,
    engine_version: ENGINE_VERSION,
    supported_profile: "accepted",
    findings: inspection.findings,
    ...(inspection.plan ? { repair_plan: inspection.plan } : {}),
  };
}

function removeSheet(xml: string, name: string): { xml: string; relationshipId: string } {
  let relationshipId = "";
  const result = xml.replace(new RegExp(`<${localElement("sheet")}\\b([^>]*?)(?:\\/>|>[\\s\\S]*?<\\/${localElement("sheet")}>)`, "gi"), (full, attributes: string) => {
    if (decodeXml(xmlAttribute(attributes, "name") ?? "") !== name) return full;
    relationshipId = xmlAttribute(attributes, "r:id") ?? xmlAttribute(attributes, "id") ?? "";
    return "";
  });
  if (!relationshipId) throw new Error(`repair target worksheet ${name} is missing`);
  return { xml: result, relationshipId };
}

function removeRelationship(xml: string, id: string): string {
  const result = xml.replace(new RegExp(`<${localElement("Relationship")}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${localElement("Relationship")}>)`, "gi"), (full) => {
    const attributes = full.match(new RegExp(`<${localElement("Relationship")}\\b([^>]*)`, "i"))?.[1] ?? "";
    return xmlAttribute(attributes, "Id") === id ? "" : full;
  });
  if (result === xml) throw new Error(`repair relationship ${id} is missing`);
  return result;
}

function removeContentType(xml: string, target: string): string {
  const normalized = `/${target}`;
  const result = xml.replace(new RegExp(`<${localElement("Override")}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${localElement("Override")}>)`, "gi"), (full) => {
    const attributes = full.match(new RegExp(`<${localElement("Override")}\\b([^>]*)`, "i"))?.[1] ?? "";
    return normalizePath(xmlAttribute(attributes, "PartName") ?? "") === target || xmlAttribute(attributes, "PartName") === normalized ? "" : full;
  });
  if (result === xml) throw new Error(`content type for ${target} is missing`);
  return result;
}

function clearCellValues(xml: string, cells: readonly string[]): string {
  const targets = new Set(cells.map((reference) => cellInfo(reference)?.reference).filter((reference): reference is string => reference !== undefined));
  const changed = new Set<string>();
  const cellPattern = new RegExp(
    "(<" + localElement("c") + "\\b[^>]*>)([\\s\\S]*?)(</" + localElement("c") + ">)|(<" + localElement("c") + "\\b[^>]*/>)",
    "gi",
  );
  const valuePattern = new RegExp(
    "<" + localElement("f|v|is") + "\\b[\\s\\S]*?(?:</" + localElement("f|v|is") + ">|\\/>)",
    "gi",
  );
  const result = xml.replace(cellPattern, (full, opening: string | undefined, content: string | undefined, closing: string | undefined) => {
    const attributes = opening?.match(new RegExp("<" + localElement("c") + "\\b([^>]*)", "i"))?.[1] ?? "";
    const reference = cellInfo(xmlAttribute(attributes, "r") ?? "")?.reference;
    if (!reference || !targets.has(reference)) return full;
    if (!opening || content === undefined || !closing) throw new Error("concealed cell is not a complete XML element");
    const cleared = content.replace(valuePattern, "");
    if (cleared === content) throw new Error("concealed cell has no clearable value");
    changed.add(reference);
    return opening + cleared + closing;
  });
  if (changed.size !== targets.size || [...targets].some((reference) => !changed.has(reference))) {
    throw new Error("repair target concealed cell is missing");
  }
  return result;
}

export function repairWorkbook(bytes: Uint8Array, plan: RepairPlan, artifactSha256: string): { bytes: Uint8Array; changedMembers: string[] } {
  if (plan.status !== "eligible" || plan.artifact_sha256 !== artifactSha256) throw new Error("repair plan is not eligible for this artifact");
  const inspection = inspectPackage(bytes, artifactSha256, plan.engine_version);
  if (!inspection.profileAccepted || !inspection.plan || canonicalJson(inspection.plan) !== canonicalJson(plan)) throw new Error("repair plan no longer matches the artifact");
  const changes = new Map<string, Uint8Array | null>();
  let workbook = decoder.decode(inspection.files["xl/workbook.xml"]!);
  let relationships = decoder.decode(inspection.files["xl/_rels/workbook.xml.rels"]!);
  let contentTypes = decoder.decode(inspection.files["[Content_Types].xml"]!);
  let workbookChanged = false;
  for (const action of plan.actions) {
    if (action.kind === "delete_hidden_worksheet") {
      workbookChanged = true;
      const removed = removeSheet(workbook, action.worksheet);
      workbook = removed.xml;
      relationships = removeRelationship(relationships, removed.relationshipId);
      if (plan.changed_members.includes("[Content_Types].xml")) {
        contentTypes = removeContentType(contentTypes, action.target_member);
      }
      changes.set(action.target_member, null);
      const relationshipPart = worksheetRelationshipMember(action.target_member);
      if (plan.changed_members.includes(relationshipPart)) changes.set(relationshipPart, null);
    } else {
      const current = decoder.decode(inspection.files[action.target_member] ?? new Uint8Array());
      changes.set(action.target_member, new TextEncoder().encode(clearCellValues(current, action.cell_references)));
    }
  }
  if (workbookChanged) {
    changes.set("xl/workbook.xml", new TextEncoder().encode(workbook));
    changes.set("xl/_rels/workbook.xml.rels", new TextEncoder().encode(relationships));
  }
  if (plan.changed_members.includes("[Content_Types].xml")) {
    changes.set("[Content_Types].xml", new TextEncoder().encode(contentTypes));
  }
  const changedMembers = unique([...changes.keys()]);
  if (canonicalJson(changedMembers) !== canonicalJson(plan.changed_members)) throw new Error("repair changed-member set is not approved");
  return { bytes: surgicalZipRewrite(bytes, changes), changedMembers };
}

function visibleBaseline(files: Record<string, Uint8Array>): string {
  const sheets = workbookSheets(files).filter((sheet) => sheet.state !== "hidden" && sheet.state !== "veryhidden");
  return sha256(canonicalJson(sheets.map((sheet) => {
    const bytes = files[sheet.path] ?? new Uint8Array();
    const xml = decoder.decode(bytes);
    const concealed = concealedCells(xml).map((cell) => cell.reference);
    const baselineXml = concealed.length > 0 ? clearCellValues(xml, concealed) : xml;
    return { name: sheet.name, path: sheet.path, xml: Buffer.from(baselineXml).toString("base64") };
  })));
}

function relationshipsValid(files: Record<string, Uint8Array>): boolean {
  for (const relationship of relationshipEntries(files)) {
    if (relationship.target && !files[relationship.target]) return false;
  }
  return true;
}

function contentTypesValid(files: Record<string, Uint8Array>): boolean {
  const xml = decoder.decode(files["[Content_Types].xml"] ?? new Uint8Array());
  for (const match of xml.matchAll(new RegExp(`<${localElement("Override")}\\b([^>]*)\\/?>(?:<\\/${localElement("Override")}>)?`, "gi"))) {
    const target = normalizePath(xmlAttribute(match[1] ?? "", "PartName") ?? "");
    if (target && !files[target]) return false;
  }
  return true;
}

function reopenSupportedPackage(files: Record<string, Uint8Array>): boolean {
  if (!files["xl/workbook.xml"] || !files["xl/worksheets/sheet1.xml"]) return false;
  return Object.entries(files).every(([name, bytes]) => (
    !(name.endsWith(".xml") || name.endsWith(".rels")) || xmlWellFormed(decoder.decode(bytes))
  ));
}

function changedMembers(original: Record<string, Uint8Array>, candidate: Record<string, Uint8Array>): string[] {
  return unique([
    ...Object.keys(original).filter((name) => !candidate[name] || sha256(original[name]!) !== sha256(candidate[name]!)),
    ...Object.keys(candidate).filter((name) => !original[name]),
  ]);
}

function approvedWorksheetChangesMatch(
  original: Record<string, Uint8Array>,
  candidate: Record<string, Uint8Array>,
  plan?: RepairPlan,
): boolean {
  for (const action of plan?.actions ?? []) {
    if (action.kind !== "clear_hidden_cell_values") continue;
    const originalXml = original[action.target_member];
    const candidateXml = candidate[action.target_member];
    if (!originalXml || !candidateXml) return false;
    if (decoder.decode(candidateXml) !== clearCellValues(decoder.decode(originalXml), action.cell_references)) return false;
  }
  return true;
}

export function verifyWorkbook(
  candidateBytes: Uint8Array,
  originalBytes: Uint8Array,
  originalArtifactSha256: string,
  candidateArtifactSha256: string,
  plan?: RepairPlan,
): EngineVerifyResult {
  try {
    const candidate = inspectPackage(candidateBytes, candidateArtifactSha256);
    const original = inspectPackage(originalBytes, originalArtifactSha256);
    const remainingFindings = candidate.findings;
    const relationships = relationshipsValid(candidate.files);
    const contentTypes = contentTypesValid(candidate.files);
    const reopened = candidate.profileAccepted && reopenSupportedPackage(candidate.files);
    const baselineUnchanged = visibleBaseline(original.files) === visibleBaseline(candidate.files);
    const actualChanges = changedMembers(original.files, candidate.files);
    const allowedChanges = new Set(plan?.changed_members ?? []);
    const unexplained = actualChanges.filter((member) => !allowedChanges.has(member));
    const changedMembersMatch = plan
      ? canonicalJson(actualChanges) === canonicalJson(plan.changed_members)
      : true;
    const approvedContentsMatch = approvedWorksheetChangesMatch(original.files, candidate.files, plan);
    const verified = candidate.profileAccepted && remainingFindings.length === 0 && relationships && contentTypes && Boolean(reopened) && baselineUnchanged && unexplained.length === 0 && changedMembersMatch && approvedContentsMatch;
    const result: EngineVerifyResult = {
      version: "1",
      operation: "verify",
      status: verified ? "verified" : "refused",
      artifact_sha256: candidateArtifactSha256,
      original_artifact_sha256: originalArtifactSha256,
      engine_version: ENGINE_VERSION,
      artifact_unchanged: baselineUnchanged,
      baseline_sha256: visibleBaseline(original.files),
      remaining_findings: remainingFindings,
      relationships_valid: relationships,
      content_types_valid: contentTypes,
      reopened_with: reopened ? ["fflate", "xml-package-reader"] : [],
      changed_members: actualChanges,
      unexplained_changes: unexplained,
    };
    if (!verified) result.refusal_code = remainingFindings.length > 0 || !candidate.profileAccepted ? "unsupported_content" : "integrity_failure";
    return result;
  } catch {
    return {
      version: "1",
      operation: "verify",
      status: "refused",
      artifact_sha256: candidateArtifactSha256,
      original_artifact_sha256: originalArtifactSha256,
      engine_version: ENGINE_VERSION,
      artifact_unchanged: false,
      baseline_sha256: candidateArtifactSha256,
      remaining_findings: [],
      relationships_valid: false,
      content_types_valid: false,
      reopened_with: [],
      changed_members: [],
      unexplained_changes: [],
      refusal_code: "integrity_failure",
    };
  }
}
