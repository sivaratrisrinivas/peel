import { unzipSync } from "fflate";

import {
  ENGINE_VERSION,
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
  return normalizePath(`${directory}/${target}`);
}

function relationshipEntries(files: Record<string, Uint8Array>): Array<{ source: string; target: string; type: string; member: string }> {
  const entries: Array<{ source: string; target: string; type: string; member: string }> = [];
  for (const [member, bytes] of Object.entries(files)) {
    if (!member.endsWith(".rels")) continue;
    const xml = decoder.decode(bytes);
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
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
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
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
  return Array.from(workbook.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gi), (match) => {
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function includesSheetReference(xml: string, sheet: SheetInfo): boolean {
  if (sheet.name.length === 0) return false;
  const name = sheet.name.replace(/'/g, "''");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:'${escaped}'|${escaped})!`, "i").test(xml) || xml.includes(sheet.path);
}

function matchingElements(xml: string, element: string, sheet: SheetInfo): boolean {
  for (const match of xml.matchAll(new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)</${element}>`, "gi"))) {
    if (includesSheetReference(match[0] ?? "", sheet)) return true;
  }
  return false;
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
    "[Content_Types].xml",
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
      `The hidden worksheet ${sheet.name} and its cell values will be removed.`,
      "Workbook behavior that depends on this worksheet was checked and is not included in the supported Repair Plan.",
    ],
  };
}

function buildPlan(
  files: Record<string, Uint8Array>,
  sheets: readonly SheetInfo[],
  findings: readonly Finding[],
  artifactSha256: string,
  engineVersion: string,
  unknownMembers: readonly string[],
): RepairPlan | undefined {
  const hidden = sheets.filter((sheet) => sheet.state === "hidden" || sheet.state === "veryhidden");
  if (hidden.length === 0) return undefined;
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
  if (findings.some((finding) => finding.mechanism !== "hidden_worksheet")) {
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
  const workbook = files["xl/workbook.xml"];
  const contentTypes = files["[Content_Types].xml"];
  const profileAccepted = Boolean(
    workbook && contentTypes && files["xl/worksheets/sheet1.xml"] &&
    decoder.decode(contentTypes).includes("spreadsheetml.sheet.main+xml") &&
    unknownMembers.length === 0,
  );
  if (!profileAccepted) return { files, sheets: workbook ? workbookSheets(files) : [], findings: [], profileAccepted: false, unknownMembers };
  const sheets = workbookSheets(files);
  const findings: Finding[] = [];
  const hiddenSheets = sheets.filter((sheet) => sheet.state === "hidden" || sheet.state === "veryhidden");
  if (hiddenSheets.length > 0) findings.push({ mechanism: "hidden_worksheet", location: "xl/workbook.xml", count: hiddenSheets.length });
  const hiddenRows = Object.entries(files).reduce((count, [name, member]) => {
    if (!name.startsWith("xl/worksheets/") || !name.endsWith(".xml")) return count;
    return count + (decoder.decode(member).match(/<(?:row|col)\b[^>]*\bhidden=["'](?:1|true)["'][^>]*>/gi) ?? []).length;
  }, 0);
  if (hiddenRows > 0) findings.push({ mechanism: "hidden_row_or_column", location: "xl/worksheets", count: hiddenRows });
  const plan = buildPlan(files, sheets, findings, artifactSha256, engineVersion, unknownMembers);
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
  const result = xml.replace(/<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/gi, (full, attributes: string) => {
    if (decodeXml(xmlAttribute(attributes, "name") ?? "") !== name) return full;
    relationshipId = xmlAttribute(attributes, "r:id") ?? xmlAttribute(attributes, "id") ?? "";
    return "";
  });
  if (!relationshipId) throw new Error(`repair target worksheet ${name} is missing`);
  return { xml: result, relationshipId };
}

function removeRelationship(xml: string, id: string): string {
  const result = xml.replace(/<Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/Relationship>)/gi, (full) => {
    const attributes = full.match(/<Relationship\b([^>]*)/i)?.[1] ?? "";
    return xmlAttribute(attributes, "Id") === id ? "" : full;
  });
  if (result === xml) throw new Error(`repair relationship ${id} is missing`);
  return result;
}

function removeContentType(xml: string, target: string): string {
  const normalized = `/${target}`;
  const result = xml.replace(/<Override\b[^>]*?(?:\/>|>[\s\S]*?<\/Override>)/gi, (full) => {
    const attributes = full.match(/<Override\b([^>]*)/i)?.[1] ?? "";
    return normalizePath(xmlAttribute(attributes, "PartName") ?? "") === target || xmlAttribute(attributes, "PartName") === normalized ? "" : full;
  });
  if (result === xml) throw new Error(`content type for ${target} is missing`);
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
  for (const action of plan.actions) {
    const removed = removeSheet(workbook, action.worksheet);
    workbook = removed.xml;
    relationships = removeRelationship(relationships, removed.relationshipId);
    contentTypes = removeContentType(contentTypes, action.target_member);
    changes.set(action.target_member, null);
    const relationshipPart = worksheetRelationshipMember(action.target_member);
    if (plan.changed_members.includes(relationshipPart)) changes.set(relationshipPart, null);
  }
  changes.set("xl/workbook.xml", new TextEncoder().encode(workbook));
  changes.set("xl/_rels/workbook.xml.rels", new TextEncoder().encode(relationships));
  changes.set("[Content_Types].xml", new TextEncoder().encode(contentTypes));
  const changedMembers = unique([...changes.keys()]);
  if (canonicalJson(changedMembers) !== canonicalJson(plan.changed_members)) throw new Error("repair changed-member set is not approved");
  return { bytes: surgicalZipRewrite(bytes, changes), changedMembers };
}

function visibleBaseline(files: Record<string, Uint8Array>): string {
  const sheets = workbookSheets(files).filter((sheet) => sheet.state !== "hidden" && sheet.state !== "veryhidden");
  return sha256(canonicalJson(sheets.map((sheet) => ({ name: sheet.name, path: sheet.path, xml: Buffer.from(files[sheet.path] ?? new Uint8Array()).toString("base64") }))));
}

function relationshipsValid(files: Record<string, Uint8Array>): boolean {
  for (const relationship of relationshipEntries(files)) {
    if (relationship.target && !files[relationship.target]) return false;
  }
  return true;
}

function contentTypesValid(files: Record<string, Uint8Array>): boolean {
  const xml = decoder.decode(files["[Content_Types].xml"] ?? new Uint8Array());
  for (const match of xml.matchAll(/<Override\b([^>]*)\/?>(?:<\/Override>)?/gi)) {
    const target = normalizePath(xmlAttribute(match[1] ?? "", "PartName") ?? "");
    if (target && !files[target]) return false;
  }
  return true;
}

function changedMembers(original: Record<string, Uint8Array>, candidate: Record<string, Uint8Array>): string[] {
  return unique([
    ...Object.keys(original).filter((name) => !candidate[name] || sha256(original[name]!) !== sha256(candidate[name]!)),
    ...Object.keys(candidate).filter((name) => !original[name]),
  ]);
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
    const reopened = candidate.profileAccepted && candidate.files["xl/workbook.xml"] && candidate.files["xl/worksheets/sheet1.xml"];
    const baselineUnchanged = visibleBaseline(original.files) === visibleBaseline(candidate.files);
    const actualChanges = changedMembers(original.files, candidate.files);
    const allowedChanges = new Set(plan?.changed_members ?? []);
    const unexplained = actualChanges.filter((member) => !allowedChanges.has(member));
    const changedMembersMatch = plan
      ? canonicalJson(actualChanges) === canonicalJson(plan.changed_members)
      : true;
    const verified = candidate.profileAccepted && remainingFindings.length === 0 && relationships && contentTypes && Boolean(reopened) && baselineUnchanged && unexplained.length === 0 && changedMembersMatch;
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
