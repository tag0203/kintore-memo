import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PARTITION_KEY = "pk";
const SORT_KEY = "sk";
const TTL_ATTRIBUTE = "ttl";

const templatePath = fileURLToPath(new URL("./template.yaml", import.meta.url));
const template = readFileSync(templatePath, "utf8");

function statement(sid) {
  const start = template.indexOf(`Sid: ${sid}`);
  expect(start).toBeGreaterThan(-1);
  const next = template.indexOf("\n              - Sid:", start + 1);
  return template.slice(start, next === -1 ? undefined : next);
}

describe("AppTable", () => {
  it("is one on-demand table with pk/sk and TTL, and no secondary indexes", () => {
    expect(template.match(/Type: AWS::DynamoDB::Table/g)).toHaveLength(1);
    expect(template).toContain("BillingMode: PAY_PER_REQUEST");
    expect(template).toContain(`AttributeName: ${PARTITION_KEY}`);
    expect(template).toContain(`AttributeName: ${SORT_KEY}`);
    expect(template).toContain("TimeToLiveSpecification:");
    expect(template).toContain(`AttributeName: ${TTL_ATTRIBUTE}`);
    expect(template).toContain("Enabled: true");
    expect(template).toContain("PointInTimeRecoveryEnabled: false");
    expect(template).not.toContain("GlobalSecondaryIndexes");
    expect(template).not.toContain("LocalSecondaryIndexes");
    expect(template).not.toContain("StreamSpecification");
    expect(template).not.toContain("/index/*");
  });
});

describe("ApiFunction runtime", () => {
  it("builds the Go Lambda in api/ and does not deploy worker/", () => {
    expect(template).toContain("Runtime: provided.al2023");
    expect(template).toContain("Handler: bootstrap");
    expect(template).toContain("CodeUri: ../api/");
    expect(template).toContain("BuildMethod: go1.x");
    expect(template).not.toContain("nodejs");
    expect(template).not.toContain("CodeUri: ../backend/");
    expect(template).not.toContain("CodeUri: ../worker/");
  });

  it("forces the fixed PermissionsBoundary on the API role", () => {
    expect(template).toContain(
      "PermissionsBoundary: !Sub arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/kintore-memo-api-permissions-boundary",
    );
  });
});

function httpApiEvents() {
  const start = template.indexOf("      Events:");
  expect(start).toBeGreaterThan(-1);
  const end = template.indexOf("      Tags:", start);
  expect(end).toBeGreaterThan(start);
  return template
    .slice(start, end)
    .split(/\n        (?=[A-Z])/)
    .filter((block) => block.includes("Type: HttpApi"));
}

describe("HttpApi CORS", () => {
  it("allows the methods the Go router serves, including preflight", () => {
    const start = template.indexOf("CorsConfiguration:");
    const end = template.indexOf("Tags:", start);
    const cors = template.slice(start, end);
    for (const method of ["GET", "POST", "PUT", "OPTIONS"]) {
      expect(cors).toContain(`- ${method}`);
    }
    // api/internal/httpapi has no DELETE or PATCH handlers.
    expect(cors).not.toContain("- DELETE");
    expect(cors).not.toContain("- PATCH");
  });

  it("uses explicit methods so OPTIONS is not authorized by the JWT authorizer", () => {
    const events = httpApiEvents();
    const health = events.find((block) => block.includes("Path: /api/health"));
    expect(health).toBeDefined();
    expect(health).toContain("Method: GET");
    expect(health).toContain("Authorizer: NONE");

    const proxy = events.filter((block) => block.includes("Path: /api/{proxy+}"));
    expect(proxy.map((block) => block.match(/Method:\s*(\S+)/)?.[1]).sort()).toEqual([
      "GET",
      "POST",
      "PUT",
    ]);
    for (const block of proxy) {
      expect(block).toContain("Authorizer: CognitoJwtAuthorizer");
      expect(block).not.toContain("Authorizer: NONE");
    }
    expect(events.some((block) => /Method:\s*ANY/.test(block))).toBe(false);
    expect(events.some((block) => /Method:\s*OPTIONS/.test(block))).toBe(false);
  });
});

describe("ApiFunction DynamoDB IAM", () => {
  it("allows item reads and writes only on the table ARN", () => {
    const policy = statement("DynamoDBTableAccess");
    for (const action of [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]) {
      expect(policy).toContain(action);
    }
    expect(policy).toContain("!GetAtt AppTable.Arn");
    expect(policy).not.toContain("index");
    for (const action of [
      "dynamodb:Scan",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DescribeTable",
    ]) {
      expect(policy).not.toContain(action);
    }
    expect(template).not.toContain("dynamodb:Scan");
  });
});
