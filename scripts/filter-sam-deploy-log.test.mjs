import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterSamDeployLog } from "./filter-sam-deploy-log.mjs";

const scriptPath = fileURLToPath(new URL("./filter-sam-deploy-log.mjs", import.meta.url));

const sample = `
	Deploying with following values
	===============================
	Stack name                   : kintore-memo-dev
	Deployment s3 bucket         : aws-sam-cli-managed-default-samclisourcebucket-example

Waiting for changeset to be created..
UPDATE_FAILED            AWS::Lambda::Function    ApiFunction                  Resource handler returned a message

CloudFormation outputs from deployed stack
-------------------------------------------------------------------------------------------------
Outputs
-------------------------------------------------------------------------------------------------
Key                 CloudFrontDistributionId
Description         CloudFront distribution ID (for cache invalidation)
Value               E123EXAMPLE
Key                 NotionDatabaseIdParameterName
Description         SSM SecureString name for the Notion database ID (create after deploy; see
docs/aws-deploy.md)
Value               /kintore-memo/dev/notion/database-id
Key                 SpaBucketName
Value               kintore-memo-dev-spa-123456789012
Key                 UserPoolId
Value               ap-northeast-1_AbCdEfGh
-------------------------------------------------------------------------------------------------

Successfully created/updated stack - kintore-memo-dev in ap-northeast-1
`;

describe("filterSamDeployLog", () => {
  it("drops the outputs table and keeps progress, errors, and the success line", () => {
    const filtered = filterSamDeployLog(sample);
    expect(filtered).toContain("Deploying with following values");
    expect(filtered).toContain("Stack name                   : kintore-memo-dev");
    expect(filtered).toContain("UPDATE_FAILED");
    expect(filtered).toContain("Resource handler returned a message");
    expect(filtered).toContain("CloudFormation stack outputs omitted from the log.");
    expect(filtered).toContain("Successfully created/updated stack - kintore-memo-dev in ap-northeast-1");
    expect(filtered).not.toContain("CloudFormation outputs from deployed stack");
    expect(filtered).not.toContain("E123EXAMPLE");
    expect(filtered).not.toContain("kintore-memo-dev-spa-123456789012");
    expect(filtered).not.toContain("ap-northeast-1_AbCdEfGh");
    expect(filtered).not.toContain("/kintore-memo/dev/notion/database-id");
    expect(filtered).not.toContain("docs/aws-deploy.md");
    expect(filtered).not.toContain("CloudFrontDistributionId");
  });

  it("passes a failure that happens before the outputs table", () => {
    const failed = [
      "Error: Failed to create changeset for the stack: kintore-memo-dev, ex: Waiter ChangeSetCreateComplete failed",
      "An error occurred (ValidationError) when calling the CreateChangeSet operation: Template error",
    ].join("\n");
    expect(filterSamDeployLog(`${failed}\n`)).toBe(`${failed}\n`);
  });

  it("keeps an error raised while the outputs table is being printed", () => {
    const text = [
      "CloudFormation outputs from deployed stack",
      "Key                 SpaBucketName",
      "Value               kintore-memo-dev-spa-123456789012",
      "Traceback (most recent call last):",
      "DeployStackOutPutFailedError: could not read outputs",
    ].join("\n");
    const filtered = filterSamDeployLog(`${text}\n`);
    expect(filtered).toContain("CloudFormation stack outputs omitted from the log.");
    expect(filtered).toContain("Traceback (most recent call last):");
    expect(filtered).toContain("DeployStackOutPutFailedError: could not read outputs");
    expect(filtered).not.toContain("kintore-memo-dev-spa-123456789012");
  });

  it("drops a JSON outputs line and keeps the JSON result line", () => {
    const text = [
      '{"type": "outputs", "stack_outputs": [{"key": "CloudFrontDistributionId", "value": "E123EXAMPLE"}]}',
      '{"type": "result", "status": "success", "stack_name": "kintore-memo-dev"}',
    ].join("\n");
    const filtered = filterSamDeployLog(`${text}\n`);
    expect(filtered).not.toContain("E123EXAMPLE");
    expect(filtered).not.toContain("stack_outputs");
    expect(filtered).toContain("CloudFormation stack outputs omitted from the log.");
    expect(filtered).toContain('"status": "success"');
  });

  it("recognizes a colored outputs header", () => {
    const text = `\u001b[32mCloudFormation outputs from deployed stack\u001b[0m\nValue               E123EXAMPLE\nSuccessfully created/updated stack - kintore-memo-dev in ap-northeast-1\n`;
    const filtered = filterSamDeployLog(text);
    expect(filtered).not.toContain("E123EXAMPLE");
    expect(filtered).toContain("Successfully created/updated stack - kintore-memo-dev in ap-northeast-1");
  });

  it("filters stdin when executed as a script", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      input: sample,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("UPDATE_FAILED");
    expect(result.stdout).toContain("Successfully created/updated stack - kintore-memo-dev in ap-northeast-1");
    expect(result.stdout).not.toContain("E123EXAMPLE");
    expect(result.stdout).not.toContain("123456789012");
    expect(result.stderr).toBe("");
  });
});
