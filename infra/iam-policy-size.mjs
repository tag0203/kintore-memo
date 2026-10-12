import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// IAM quotas for this template. Whitespace outside JSON strings does not count,
// so the estimate is the UTF-8 length of the minified document CloudFormation
// submits after resolving intrinsics. Defaults match the bootstrap region.
export const MANAGED_POLICY_LIMIT = 6144;
export const ROLE_INLINE_LIMIT = 10240;
export const MANAGED_POLICIES_PER_ROLE = 10;

const DEFAULT_ASSUMPTIONS = {
  partition: "aws",
  region: "ap-northeast-1",
  accountId: "123456789012",
};

function unquote(token) {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  return token;
}

function parseScalarToken(token) {
  if (token.startsWith("!Sub ")) {
    return { "Fn::Sub": unquote(token.slice(5).trim()) };
  }
  if (token.startsWith("!Ref ")) {
    const name = token.slice(5).trim();
    if (!/^[A-Za-z0-9]+$/.test(name)) {
      throw new Error(`unsupported Ref ${name}`);
    }
    return { Ref: name };
  }
  if (token.startsWith("!")) {
    throw new Error(`unsupported YAML tag in policy document: ${token}`);
  }
  return unquote(token);
}

function splitKeyValue(trimmed) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble && c === ":") {
      const rest = trimmed.slice(i + 1);
      if (rest === "" || rest.startsWith(" ")) {
        const valueText = rest.trim();
        return { key: unquote(trimmed.slice(0, i).trim()), valueText, hasValue: valueText !== "" };
      }
    }
  }
  return null;
}

function indentOf(line) {
  let i = 0;
  while (line[i] === " ") i++;
  return i;
}

function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseBlock(lines, start, minIndent) {
  let i = start;
  while (i < lines.length && isSkippable(lines[i])) i++;
  if (i >= lines.length || indentOf(lines[i]) < minIndent) {
    throw new Error(`expected a nested YAML value at line ${start + 1}`);
  }
  const trimmed = lines[i].slice(indentOf(lines[i]));
  if (trimmed.startsWith("- ")) return parseList(lines, i, indentOf(lines[i]));
  return parseMap(lines, i, indentOf(lines[i]));
}

function parseMap(lines, i, mapIndent) {
  const obj = {};
  while (i < lines.length) {
    while (i < lines.length && isSkippable(lines[i])) i++;
    if (i >= lines.length) break;
    const ind = indentOf(lines[i]);
    if (ind < mapIndent) break;
    if (ind > mapIndent) {
      throw new Error(`unexpected indent at line ${i + 1}: ${lines[i]}`);
    }
    const trimmed = lines[i].slice(ind);
    if (trimmed.startsWith("- ")) break;
    const kv = splitKeyValue(trimmed);
    if (!kv) throw new Error(`expected a key at line ${i + 1}: ${lines[i]}`);
    if (!kv.hasValue) {
      const nested = parseBlock(lines, i + 1, mapIndent + 1);
      obj[kv.key] = nested.value;
      i = nested.i;
    } else {
      obj[kv.key] = parseScalarToken(kv.valueText);
      i++;
    }
  }
  return { value: obj, i };
}

function parseList(lines, i, listIndent) {
  const arr = [];
  while (i < lines.length) {
    while (i < lines.length && isSkippable(lines[i])) i++;
    if (i >= lines.length) break;
    const ind = indentOf(lines[i]);
    if (ind < listIndent) break;
    if (ind !== listIndent) {
      throw new Error(`unexpected list indent at line ${i + 1}: ${lines[i]}`);
    }
    const trimmed = lines[i].slice(ind);
    if (!trimmed.startsWith("- ")) {
      throw new Error(`expected a list item at line ${i + 1}: ${lines[i]}`);
    }
    const rest = trimmed.slice(2);
    if (rest === "") {
      const nested = parseBlock(lines, i + 1, listIndent + 2);
      arr.push(nested.value);
      i = nested.i;
      continue;
    }
    const kv = splitKeyValue(rest);
    if (kv) {
      const obj = {};
      if (!kv.hasValue) {
        const nested = parseBlock(lines, i + 1, listIndent + 2);
        obj[kv.key] = nested.value;
        i = nested.i;
      } else {
        obj[kv.key] = parseScalarToken(kv.valueText);
        i++;
      }
      const more = parseMap(lines, i, listIndent + 2);
      Object.assign(obj, more.value);
      i = more.i;
      arr.push(obj);
    } else {
      arr.push(parseScalarToken(rest.trim()));
      i++;
    }
  }
  return { value: arr, i };
}

function resolveNode(node, assumptions, refs) {
  if (Array.isArray(node)) return node.map((item) => resolveNode(item, assumptions, refs));
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === "Fn::Sub") {
      const raw = node["Fn::Sub"];
      if (typeof raw !== "string") throw new Error("only string Fn::Sub is supported");
      const resolved = raw.replace(/\$\{[^}]+\}/g, (match) => {
        if (!Object.hasOwn(assumptions.substitutions, match)) {
          throw new Error(`unresolved ${match} in ${raw}`);
        }
        return assumptions.substitutions[match];
      });
      return resolved;
    }
    if (keys.length === 1 && keys[0] === "Ref") {
      if (!Object.hasOwn(refs, node.Ref)) throw new Error(`unresolved Ref ${node.Ref}`);
      return refs[node.Ref];
    }
    const out = {};
    for (const key of keys) out[key] = resolveNode(node[key], assumptions, refs);
    return out;
  }
  return node;
}

function documentBytes(document, assumptions, refs) {
  const resolved = resolveNode(document, assumptions, refs);
  return Buffer.byteLength(JSON.stringify(resolved), "utf8");
}

function propertyBlock(lines, resourceStart, resourceEnd, key) {
  const prefix = `      ${key}:`;
  for (let i = resourceStart; i < resourceEnd; i++) {
    if (lines[i] === prefix || lines[i].startsWith(`${prefix} `)) {
      if (lines[i] === prefix) return parseBlock(lines, i + 1, 8).value;
      const inline = lines[i].slice(prefix.length).trim();
      return parseScalarToken(inline);
    }
  }
  return undefined;
}

function resourcesIn(lines) {
  const resourcesStart = lines.findIndex((line) => line === "Resources:");
  if (resourcesStart < 0) throw new Error("template has no Resources");
  let resourcesEnd = lines.length;
  for (let i = resourcesStart + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i])) {
      resourcesEnd = i;
      break;
    }
  }
  const starts = [];
  for (let i = resourcesStart + 1; i < resourcesEnd; i++) {
    if (/^  [A-Za-z0-9]+:\s*$/.test(lines[i])) starts.push(i);
  }
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : resourcesEnd;
    const logicalId = lines[start].trim().replace(/:$/, "");
    let type = "";
    for (let i = start; i < end; i++) {
      const match = lines[i].match(/^    Type:\s*(\S+)\s*$/);
      if (match) {
        type = match[1];
        break;
      }
    }
    return { logicalId, type, start, end };
  });
}

function policyDocumentsIn(lines, resource) {
  const docs = [];
  for (let i = resource.start; i < resource.end; i++) {
    const match = lines[i].match(/^( *)PolicyDocument:\s*$/);
    if (!match) continue;
    const parsed = parseBlock(lines, i + 1, match[1].length + 1);
    docs.push({ line: i + 1, document: parsed.value });
  }
  return docs;
}

function canonicalStatement(statement) {
  return JSON.parse(JSON.stringify(statement));
}

/**
 * Estimate IAM policy sizes for infra/github-oidc.yaml.
 * Managed policies must each stay within 6,144 bytes. Inline policy documents
 * on one role share a 10,240-byte aggregate. A role can attach 10 managed policies.
 */
export function estimateIamPolicies(template, options = {}) {
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...options };
  assumptions.substitutions = {
    "${AWS::Partition}": assumptions.partition,
    "${AWS::Region}": assumptions.region,
    "${AWS::AccountId}": assumptions.accountId,
  };
  if (template.includes("\t")) throw new Error("policy template uses tabs");
  const lines = template.split(/\r?\n/);
  const resources = resourcesIn(lines);
  const boundaryArn = `arn:${assumptions.partition}:iam::${assumptions.accountId}:policy/kintore-memo-api-permissions-boundary`;
  const refs = { ApiFunctionPermissionsBoundary: boundaryArn };

  const roles = new Map();
  for (const resource of resources) {
    if (resource.type !== "AWS::IAM::Role") continue;
    const roleName = propertyBlock(lines, resource.start, resource.end, "RoleName");
    if (typeof roleName !== "string") throw new Error(`${resource.logicalId} has no RoleName`);
    const arns = propertyBlock(lines, resource.start, resource.end, "ManagedPolicyArns") ?? [];
    if (!Array.isArray(arns)) throw new Error(`${resource.logicalId} ManagedPolicyArns is not a list`);
    roles.set(resource.logicalId, {
      logicalId: resource.logicalId,
      roleName,
      inlineBytes: 0,
      inlinePolicies: [],
      managedPolicyRefs: arns.map((item) => {
        if (!item || typeof item !== "object" || item.Ref == null) {
          throw new Error(`${resource.logicalId} ManagedPolicyArns entry is not a Ref`);
        }
        return item.Ref;
      }),
    });
  }

  const managed = [];
  const statements = [];
  for (const resource of resources) {
    const docs = policyDocumentsIn(lines, resource);
    if (resource.type === "AWS::IAM::ManagedPolicy") {
      if (docs.length !== 1) throw new Error(`${resource.logicalId} should have one PolicyDocument`);
      const name = propertyBlock(lines, resource.start, resource.end, "ManagedPolicyName");
      if (typeof name !== "string") throw new Error(`${resource.logicalId} has no ManagedPolicyName`);
      const bytes = documentBytes(docs[0].document, assumptions, refs);
      const roleList = propertyBlock(lines, resource.start, resource.end, "Roles") ?? [];
      managed.push({
        logicalId: resource.logicalId,
        name,
        bytes,
        roleRefs: roleRefs(roleList, resource.logicalId),
      });
      pushStatements(statements, docs[0].document, assumptions, refs);
    } else if (resource.type === "AWS::IAM::Policy") {
      if (docs.length !== 1) throw new Error(`${resource.logicalId} should have one PolicyDocument`);
      const bytes = documentBytes(docs[0].document, assumptions, refs);
      const roleList = propertyBlock(lines, resource.start, resource.end, "Roles") ?? [];
      for (const roleId of roleRefs(roleList, resource.logicalId)) {
        const role = roles.get(roleId);
        if (!role) throw new Error(`${resource.logicalId} references unknown role ${roleId}`);
        role.inlineBytes += bytes;
        role.inlinePolicies.push({ logicalId: resource.logicalId, bytes });
      }
      pushStatements(statements, docs[0].document, assumptions, refs);
    } else if (resource.type === "AWS::IAM::Role") {
      const role = roles.get(resource.logicalId);
      for (const doc of docs) {
        const bytes = documentBytes(doc.document, assumptions, refs);
        role.inlineBytes += bytes;
        role.inlinePolicies.push({ logicalId: resource.logicalId, line: doc.line, bytes });
        pushStatements(statements, doc.document, assumptions, refs);
      }
    } else if (docs.length > 0) {
      throw new Error(`unexpected PolicyDocument on ${resource.logicalId}`);
    }
  }

  for (const policy of managed) {
    for (const roleId of policy.roleRefs) {
      const role = roles.get(roleId);
      if (!role) throw new Error(`${policy.logicalId} references unknown role ${roleId}`);
      role.managedPolicyRefs.push(policy.logicalId);
    }
  }

  const violations = [];
  for (const policy of managed) {
    if (policy.bytes > MANAGED_POLICY_LIMIT) {
      violations.push(
        `${policy.name} is ${policy.bytes} bytes, over the ${MANAGED_POLICY_LIMIT}-byte managed policy limit`,
      );
    }
  }
  for (const role of roles.values()) {
    if (role.inlineBytes > ROLE_INLINE_LIMIT) {
      violations.push(
        `${role.roleName} inline policies are ${role.inlineBytes} bytes, over the ${ROLE_INLINE_LIMIT}-byte aggregate limit`,
      );
    }
    if (role.managedPolicyRefs.length > MANAGED_POLICIES_PER_ROLE) {
      violations.push(
        `${role.roleName} attaches ${role.managedPolicyRefs.length} managed policies, over the limit of ${MANAGED_POLICIES_PER_ROLE}`,
      );
    }
  }

  return {
    assumptions: {
      partition: assumptions.partition,
      region: assumptions.region,
      accountId: assumptions.accountId,
    },
    managed,
    roles: [...roles.values()],
    statements,
    violations,
  };
}

function roleRefs(roleList, logicalId) {
  if (!Array.isArray(roleList)) throw new Error(`${logicalId} Roles is not a list`);
  return roleList.map((item) => {
    if (!item || typeof item !== "object" || item.Ref == null) {
      throw new Error(`${logicalId} Roles entry is not a Ref`);
    }
    return item.Ref;
  });
}

function pushStatements(statements, document, assumptions, refs) {
  const resolved = resolveNode(document, assumptions, refs);
  if (!Array.isArray(resolved.Statement)) throw new Error("PolicyDocument has no Statement list");
  for (const statement of resolved.Statement) {
    if (typeof statement.Sid !== "string") throw new Error("policy statement is missing Sid");
    statements.push(canonicalStatement(statement));
  }
}

export function canonicalStatements(statements) {
  return statements.map((statement) => sortKeys(statement)).sort((a, b) => (a.Sid < b.Sid ? -1 : a.Sid > b.Sid ? 1 : 0));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function reportText(report) {
  const lines = [
    `assumptions partition=${report.assumptions.partition} region=${report.assumptions.region} account=${report.assumptions.accountId}`,
  ];
  for (const policy of report.managed) {
    lines.push(`managed ${policy.name} ${policy.bytes}/${MANAGED_POLICY_LIMIT}`);
  }
  for (const role of report.roles) {
    lines.push(
      `role ${role.roleName} inline ${role.inlineBytes}/${ROLE_INLINE_LIMIT} managed-attachments ${role.managedPolicyRefs.length}/${MANAGED_POLICIES_PER_ROLE}`,
    );
  }
  if (report.violations.length === 0) lines.push("ok");
  else lines.push(...report.violations);
  return lines.join("\n");
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const templatePath = fileURLToPath(new URL("./github-oidc.yaml", import.meta.url));
  const report = estimateIamPolicies(readFileSync(templatePath, "utf8"));
  console.log(reportText(report));
  if (report.violations.length > 0) process.exit(1);
}
