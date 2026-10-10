import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCspSub, inlineDocumentViolations, renderCsp } from "../scripts/csp-policy.mjs";

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

describe("Cognito token lifetimes", () => {
  it("keeps access and id tokens at 1 hour and shortens refresh tokens to 7 days", () => {
    const start = template.indexOf("UserPoolClient:");
    const end = template.indexOf("AppTable:", start);
    const client = template.slice(start, end);
    expect(client).toContain("AccessTokenValidity: 1");
    expect(client).toContain("IdTokenValidity: 1");
    expect(client).toContain("RefreshTokenValidity: 7");
    expect(client).not.toContain("RefreshTokenValidity: 30");
    expect(client).toContain("AccessToken: hours");
    expect(client).toContain("IdToken: hours");
    expect(client).toContain("RefreshToken: days");
  });
});

describe("CloudFront response headers", () => {
  it("attaches a custom policy with HSTS, frame denial, nosniff, referrer policy, and robots", () => {
    expect(template.match(/Type: AWS::CloudFront::ResponseHeadersPolicy/g)).toHaveLength(1);
    expect(template).toContain("ResponseHeadersPolicyId: !Ref SpaResponseHeadersPolicy");
    const start = template.indexOf("SpaResponseHeadersPolicy:");
    const end = template.indexOf("SpaDistribution:", start);
    const policy = template.slice(start, end);
    expect(policy).toContain("StrictTransportSecurity:");
    expect(policy).toContain("AccessControlMaxAgeSec: 31536000");
    expect(policy).toContain("IncludeSubdomains: true");
    expect(policy).not.toContain("Preload:");
    expect(policy).toContain("ContentTypeOptions:");
    expect(policy).toContain("FrameOption: DENY");
    expect(policy).toContain("ReferrerPolicy: strict-origin-when-cross-origin");
    expect(policy).toContain("Header: X-Robots-Tag");
    expect(policy).toContain("Value: noindex, nofollow");
    expect(policy).toContain("RemoveHeadersConfig:");
    expect(policy).toContain("Header: Server");
    expect(policy).not.toContain("XSSProtection");
  });

  it("derives an exact CSP for this API, Cognito, the service worker, and the manifest", () => {
    const sub = extractCspSub(template);
    expect(sub).toContain("${HttpApi}");
    expect(sub).toContain("${AWS::Region}");
    expect(sub).not.toContain("*");
    const csp = renderCsp(sub, "ap-northeast-1", "a1b2c3d4e5");
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://cognito-idp.ap-northeast-1.amazonaws.com https://a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("does not reference the distribution from API CORS, which would cycle with the CSP", () => {
    const start = template.indexOf("CorsConfiguration:");
    const end = template.indexOf("Tags:", start);
    const cors = template.slice(start, end);
    expect(cors).toContain("HasSpaAllowedOrigin");
    expect(cors).toContain("!Ref SpaAllowedOrigin");
    expect(cors).not.toContain("SpaDistribution");
    const envStart = template.indexOf("Environment:\n        Variables:");
    const envEnd = template.indexOf("Events:", envStart);
    const env = template.slice(envStart, envEnd);
    expect(env).toContain("ALLOWED_ORIGIN: !Ref SpaAllowedOrigin");
    expect(env).not.toContain("!GetAtt SpaDistribution");
    expect(env).not.toContain("${SpaDistribution.DomainName}");
    expect(template).toContain('AllowedPattern: "^$|^https://[a-z0-9]+\\\\.cloudfront\\\\.net$"');
  });
});

describe("search engine blocking", () => {
  it("disallows all crawlers in robots.txt and the document", () => {
    const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
    expect(robots).toBe("User-agent: *\nDisallow: /\n");
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(inlineDocumentViolations(html)).toEqual([]);
  });
});
