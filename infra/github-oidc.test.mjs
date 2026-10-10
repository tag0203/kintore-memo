import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templatePath = fileURLToPath(new URL("./github-oidc.yaml", import.meta.url));
const template = readFileSync(templatePath, "utf8");

describe("GitHub OIDC bootstrap", () => {
  it("defines a PermissionsBoundary and requires it on API role IAM changes", () => {
    expect(template).toContain("ApiFunctionPermissionsBoundary");
    expect(template).toContain("ManagedPolicyName: kintore-memo-api-permissions-boundary");
    expect(template).toContain("CreateApiFunctionRoleWithBoundary");
    expect(template).toContain("ManageBoundedApiFunctionRoles");
    expect(template).toContain("DenyStripApiRoleBoundary");
    expect(template).toContain("iam:PermissionsBoundary: !Ref ApiFunctionPermissionsBoundary");
    expect(template).toContain("iam:DeleteRolePermissionsBoundary");
  });

  it("limits AssumeRole to main and the Deploy workflow name (AWS-mapped claim)", () => {
    expect(template).toContain("token.actions.githubusercontent.com:workflow");
    expect(template).not.toContain("token.actions.githubusercontent.com:workflow_ref");
    expect(template).not.toContain("token.actions.githubusercontent.com:job_workflow_ref");
    expect(template).not.toContain("token.actions.githubusercontent.com:event_name");
    expect(template).toContain("DeployWorkflowName");
    expect(template).toContain("Default: Deploy");
    expect(template).toContain("ref:refs/heads/${AllowedBranch}");
  });

  it("points the deploy role output at the Actions secret, not a variable", () => {
    expect(template).toContain("GitHub Actions secret AWS_DEPLOY_ROLE_ARN. Do not commit the value.");
    expect(template).not.toContain("GitHub Actions variable AWS_DEPLOY_ROLE_ARN");
  });

  it("keeps Notion SSM and access-key denies on the deploy role", () => {
    expect(template).toContain("DenyNotionParameterAccess");
    expect(template).toContain("DenyAccessKeys");
  });

  it("can set and clear reserved concurrency only on the API functions", () => {
    const statement = template.slice(
      template.indexOf("Sid: LambdaAppFunctions"),
      template.indexOf("Sid: PassRoleToLambdaOnly"),
    );
    expect(statement).toContain("lambda:PutFunctionConcurrency");
    expect(statement).toContain("lambda:DeleteFunctionConcurrency");
    expect(statement).toContain("function:kintore-memo-*-api");
    expect(statement).not.toContain('Resource: "*"');
  });

  it("can create the HTTP API access log group and the log delivery the stage needs", () => {
    const groups = template.slice(
      template.indexOf("Sid: ApiLogGroups"),
      template.indexOf("Sid: HttpApiAccessLogDelivery"),
    );
    expect(groups).toContain("logs:CreateLogGroup");
    expect(groups).toContain("log-group:/aws/apigateway/kintore-memo-*-http");
    expect(groups).not.toContain('Resource: "*"');

    const delivery = template.slice(
      template.indexOf("Sid: HttpApiAccessLogDelivery"),
      template.indexOf("Sid: ReadHttpApiAccessLogGroup"),
    );
    for (const action of [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
    ]) {
      expect(delivery).toContain(action);
    }
    expect(delivery).toContain('Resource: "*"');
    for (const action of [
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DeleteResourcePolicy",
    ]) {
      expect(delivery).not.toContain(action);
    }

    const readLogs = template.slice(
      template.indexOf("Sid: ReadHttpApiAccessLogGroup"),
      template.indexOf("Sid: HttpApi\n"),
    );
    for (const action of ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"]) {
      expect(readLogs).toContain(action);
    }
    expect(readLogs).toContain("log-group:/aws/apigateway/kintore-memo-*-http");
    expect(readLogs).toContain("log-group:/aws/apigateway/kintore-memo-*-http:*");
    expect(readLogs).not.toContain('Resource: "*"');
    expect(readLogs).not.toContain("/aws/lambda/");
  });

  it("keeps stage updates, including access log settings, on the existing /apis verbs", () => {
    const statement = template.slice(template.indexOf("Sid: HttpApi\n"), template.indexOf("Sid: CognitoCreateUserPool"));
    for (const action of ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"]) {
      expect(statement).toContain(action);
    }
    expect(statement).toContain("arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*");
  });

  it("allows HTTP API stage tagging on this region's /apis ARN only", () => {
    const policy = template.slice(
      template.indexOf("HttpApiStageTagPolicy:"),
      template.indexOf("Outputs:"),
    );
    expect(policy).toContain("PolicyName: HttpApiStageTags");
    expect(policy).toContain("Roles:\n        - !Ref GitHubDeployRole");
    expect(policy).toContain("apigateway:TagResource");
    expect(policy).toContain("apigateway:UntagResource");
    expect(policy).toContain("arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis");
    expect(policy).toContain("arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*");
    expect(policy).not.toContain("/tags/");
    expect(policy).not.toContain('Resource: "*"');
    expect(policy).toContain("W3037");
  });

  it("lets the deploy role manage response headers policies in this account only", () => {
    const create = template.slice(
      template.indexOf("Sid: CloudFrontCreateResponseHeadersPolicy"),
      template.indexOf("Sid: CloudFrontResponseHeadersPolicies"),
    );
    expect(create).toContain("cloudfront:CreateResponseHeadersPolicy");
    expect(create).toContain('Resource: "*"');
    expect(create).not.toContain("GetResponseHeadersPolicy");
    expect(create).not.toContain("UpdateResponseHeadersPolicy");
    expect(create).not.toContain("DeleteResponseHeadersPolicy");

    const manage = template.slice(
      template.indexOf("Sid: CloudFrontResponseHeadersPolicies"),
      template.indexOf("Sid: DenyNotionParameterAccess"),
    );
    for (const action of [
      "cloudfront:GetResponseHeadersPolicy",
      "cloudfront:GetResponseHeadersPolicyConfig",
      "cloudfront:UpdateResponseHeadersPolicy",
      "cloudfront:DeleteResponseHeadersPolicy",
    ]) {
      expect(manage).toContain(action);
    }
    expect(manage).toContain(
      "arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:response-headers-policy/*",
    );
    expect(manage).not.toContain('Resource: "*"');
    expect(manage).not.toContain("ListResponseHeadersPolicies");
  });
});
