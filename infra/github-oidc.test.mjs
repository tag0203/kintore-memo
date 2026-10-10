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

  it("keeps Notion SSM and access-key denies on the deploy role", () => {
    expect(template).toContain("DenyNotionParameterAccess");
    expect(template).toContain("DenyAccessKeys");
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
});
