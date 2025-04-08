import { awscdk, javascript } from "projen";

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.188.0",
  defaultReleaseBranch: "main",
  depsUpgradeOptions: { workflow: false },
  eslint: true,
  gitignore: ["**/target"],
  minNodeVersion: "22.14.0",
  name: "cdk-aws-otlp-forwarder-cwl-lambda",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: "10",
  prettier: true,
  projenrcTs: true,

  deps: [
    "@aws-sdk/client-sqs",
    "@dev7a/lambda-otel-lite",
    "@dev7a/otlp-stdout-exporter",
    "@middy/core",
    "@opentelemetry/api",
    "@opentelemetry/core",
    "@opentelemetry/instrumentation",
    "@opentelemetry/instrumentation-aws-sdk",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-undici",
    "@opentelemetry/otlp-exporter-base",
    "@opentelemetry/resource-detector-aws",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/semantic-conventions",
    "@types/aws-lambda",
    "cargo-lambda-cdk",
    "uv-python-lambda",
    "zod",
  ],
});

project.synth();
