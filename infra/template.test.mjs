import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PARTITION_KEY, SORT_KEY, TTL_ATTRIBUTE } from "../backend/dynamodb.mjs";

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
  it("builds the Go Lambda and leaves the Node backend and worker undeployed", () => {
    expect(template).toContain("Runtime: provided.al2023");
    expect(template).toContain("Handler: bootstrap");
    expect(template).toContain("CodeUri: ../api/");
    expect(template).toContain("BuildMethod: go1.x");
    expect(template).not.toContain("nodejs");
    expect(template).not.toContain("CodeUri: ../backend/");
    expect(template).not.toContain("CodeUri: ../worker/");
  });
});

describe("HttpApi CORS", () => {
  it("allows PUT so the browser can save a DayPlan", () => {
    const start = template.indexOf("CorsConfiguration:");
    const end = template.indexOf("Tags:", start);
    const cors = template.slice(start, end);
    expect(cors).toContain("- PUT");
    expect(cors).toContain("- GET");
    expect(cors).toContain("- OPTIONS");
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
