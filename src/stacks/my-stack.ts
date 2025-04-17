import {
  CfnOutput,
  DockerImage,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import {
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  FunctionUrlAuthType,
  LoggingFormat,
  Runtime,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnAccountPolicy } from "aws-cdk-lib/aws-logs";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { RustFunction } from "cargo-lambda-cdk";
import { Construct } from "constructs";
import { join } from "path";
import { PythonFunction } from "uv-python-lambda";
import { validateEnv } from "../utils/validate-env";

// Constants
const COLLECTORS_SECRETS_KEY_PREFIX = "serverless-otlp-forwarder/keys/";

// Required environment variables
const env = validateEnv([
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // SECRETS MANAGER
    //==============================================================================

    new Secret(this, "VendorSecret", {
      secretName: `${COLLECTORS_SECRETS_KEY_PREFIX}vendor`,
      description: "Vendor API key for OTLP forwarder",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({
          name: "vendor",
          endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
          auth: env.OTEL_EXPORTER_OTLP_HEADERS,
        }),
      ),
    });

    //==============================================================================
    // DYNAMODB
    //==============================================================================

    const quotesTable = new TableV2(this, "QuotesTable", {
      tableName: "quotes-table",
      partitionKey: { name: "pk", type: AttributeType.STRING },
      timeToLiveAttribute: "expiry",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // API GATEWAY
    //==============================================================================

    const backendApi = new RestApi(this, "BackendApi", {
      restApiName: "backend-api",
      endpointTypes: [EndpointType.REGIONAL],
    });
    backendApi.node.tryRemoveChild("Endpoint");

    //==============================================================================
    // LAMBDA - SERVICE FUNCTIONS
    //==============================================================================

    // Backend Lambda
    const backendLambda = new RustFunction(this, "BackendLambda", {
      functionName: "backend-lambda",
      manifestPath: join(__dirname, "../functions/service", "Cargo.toml"),
      binaryName: "backend",
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        TABLE_NAME: quotesTable.tableName,
      },
    });
    quotesTable.grantReadWriteData(backendLambda);

    // Frontend Lambda
    const frontendLambda = new RustFunction(this, "frontendLambda", {
      functionName: "frontend-lambda",
      manifestPath: join(__dirname, "../functions/service", "Cargo.toml"),
      binaryName: "frontend",
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      tracing: Tracing.ACTIVE,
      environment: {
        TARGET_URL: backendApi.url,
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
      },
    });
    const frontendLambdaUrl = frontendLambda.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // API GATEWAY INTEGRATIONS
    //==============================================================================

    // {api}/quotes
    const quotesResource = backendApi.root.resourceForPath("/quotes");
    quotesResource.addMethod("GET", new LambdaIntegration(backendLambda));
    quotesResource.addMethod("POST", new LambdaIntegration(backendLambda));

    // {api}/quotes/{id}
    const quoteByIdResource = backendApi.root.resourceForPath("/quotes/{id}");
    quoteByIdResource.addMethod("GET", new LambdaIntegration(backendLambda));

    //==============================================================================
    // LAMBDA - CLIENT FUNCTIONS
    //==============================================================================

    // Client Node Lambda
    const clientNodeLambda = new NodejsFunction(this, "ClientNodeLambda", {
      functionName: "client-node-lambda",
      entry: join(__dirname, "../functions/client-node", "index.ts"),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        TARGET_URL: `${backendApi.url}quotes`,
      },
    });
    new Schedule(this, "ClientNodeLambdaSchedule", {
      scheduleName: `client-node-lambda-schedule`,
      description: `Trigger ${clientNodeLambda.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientNodeLambda),
    });

    // Client Python Lambda
    const clientPythonLambda = new PythonFunction(this, "ClientPythonLambda", {
      functionName: "client-python-lambda",
      rootDir: join(__dirname, "../functions/client-python"),
      runtime: Runtime.PYTHON_3_13,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        TARGET_URL: `${backendApi.url}quotes`,
      },
      bundling: {
        image: DockerImage.fromBuild(
          join(__dirname, "../functions/client-python"),
        ),
        assetExcludes: ["Dockerfile", ".venv"],
      },
    });
    new Schedule(this, "ClientPythonLambdaSchedule", {
      scheduleName: `client-python-lambda-schedule`,
      description: `Trigger ${clientPythonLambda.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientPythonLambda),
    });

    // Client Rust Lambda
    const clientRustLambda = new RustFunction(this, "ClientRustLambda", {
      functionName: "client-rust-lambda",
      manifestPath: join(__dirname, "../functions/client-rust", "Cargo.toml"),
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      tracing: Tracing.ACTIVE,
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
      },
    });
    const clientRustLambdaUrl = clientRustLambda.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // LAMBDA - OTLP FORWARDER
    //==============================================================================

    // Forwarder Lambda
    const forwarderLambda = new RustFunction(this, "ForwarderLambda", {
      functionName: "forwarder-lambda",
      description: `Processes logs from AWS Account ${this.account}`,
      manifestPath: join(__dirname, "../functions/forwarder", "Cargo.toml"),
      binaryName: "stdout_processor",
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 128,
      loggingFormat: LoggingFormat.JSON,
      environment: {
        COLLECTORS_CACHE_TTL_SECONDS: "300",
        COLLECTORS_SECRETS_KEY_PREFIX,
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        LAMBDA_TRACING_ENABLE_FMT_LAYER: "false",
        OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_HEADERS: env.OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      },
    });
    // Grant the forwarder lambda permission to access secrets
    forwarderLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:BatchGetSecretValue",
          "secretsmanager:ListSecrets",
        ],
        resources: ["*"],
      }),
    );

    //==============================================================================
    // CLOUDWATCH LOGS
    //==============================================================================

    // Grant CloudWatch Logs permission to invoke the forwarder lambda
    forwarderLambda.addPermission("ForwarderLambdaCwlPermission", {
      principal: new ServicePrincipal("logs.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
      sourceAccount: this.account,
    });

    // Create account-level subscription filter
    const forwarderLambdaAccountSubFilter = new CfnAccountPolicy(
      this,
      "ForwarderLambdaAccountSubFilter",
      {
        policyName: "ForwarderLambdaAccountSubFilter",
        policyDocument: JSON.stringify({
          DestinationArn: forwarderLambda.functionArn,
          FilterPattern: "{ $.__otel_otlp_stdout = * }",
          Distribution: "Random",
        }),
        policyType: "SUBSCRIPTION_FILTER_POLICY",
        scope: "ALL",
        selectionCriteria: `LogGroupName NOT IN ["/aws/lambda/${forwarderLambda.functionName}"]`,
      },
    );

    // Ensure the subscription filter is created after the CloudWatch Logs permission
    forwarderLambdaAccountSubFilter.node.addDependency(forwarderLambda);

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "QuotesApiUrl", {
      value: `${backendApi.url}quotes`,
    });

    new CfnOutput(this, "FrontendLambdaUrl", {
      value: frontendLambdaUrl.url,
    });

    new CfnOutput(this, "ClientRustLambdaUrl", {
      value: clientRustLambdaUrl.url,
    });
  }
}
