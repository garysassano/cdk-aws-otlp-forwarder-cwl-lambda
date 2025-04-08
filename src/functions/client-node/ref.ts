import {
  initTelemetry,
  createTracedHandler,
  LambdaContext,
} from "@dev7a/lambda-otel-lite";
import {
  defaultExtractor,
  TriggerType,
} from "@dev7a/lambda-otel-lite/dist/internal/telemetry/extractors";
import { trace, SpanStatusCode, Span } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { AwsInstrumentation } from "@opentelemetry/instrumentation-aws-sdk";
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { ScheduledEvent } from "aws-lambda";

// Initialize telemetry with default configuration
// The service name will be automatically set from OTEL_SERVICE_NAME
// or AWS_LAMBDA_FUNCTION_NAME environment variables
const { tracer, completionHandler } = initTelemetry();

// Register instrumentations
registerInstrumentations({
  tracerProvider: trace.getTracerProvider(),
  instrumentations: [new AwsInstrumentation(), new HttpInstrumentation()],
});

// Create SQS client
const sqs = new (require("@aws-sdk/client-sqs").SQSClient)();
const { SendMessageCommand } = require("@aws-sdk/client-sqs");

const QUOTES_URL = "https://dummyjson.com/quotes/random";
const QUEUE_URL = process.env.QUOTES_QUEUE_URL;

// Define the quote interface
interface Quote {
  id: number;
  quote: string;
  author: string;
}

// Helper function to get random quote from dummyjson
async function getRandomQuote(): Promise<Quote> {
  return tracer.startActiveSpan("getRandomQuote", async (span: Span) => {
    try {
      const response = await fetch(QUOTES_URL);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data as Quote;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Helper function to send quote to SQS
async function sendQuote(quote: Quote): Promise<void> {
  return tracer.startActiveSpan("sendQuote", async (span: Span) => {
    try {
      const messageParams: SendMessageCommandInput = {
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(quote),
        MessageAttributes: {
          quote_id: {
            DataType: "String",
            StringValue: quote.id.toString(),
          },
          author: {
            DataType: "String",
            StringValue: quote.author,
          },
        },
      };
      const command = new SendMessageCommand(messageParams);
      await sqs.send(command);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Process a single quote
async function processQuote(
  quoteNumber: number,
  totalQuotes: number,
): Promise<Quote> {
  const activeSpan = trace.getActiveSpan();
  const quote = await getRandomQuote();

  activeSpan?.addEvent("Random Quote Fetched", {
    "log.severity": "info",
    "log.message": `Successfully fetched random quote ${quoteNumber}/${totalQuotes}`,
    "quote.text": quote.quote,
    "quote.author": quote.author,
  });

  await sendQuote(quote);

  activeSpan?.addEvent("Quote Sent", {
    "log.severity": "info",
    "log.message": `Quote ${quoteNumber}/${totalQuotes} sent to SQS`,
    "quote.id": quote.id,
  });

  return quote;
}

// Process a batch of quotes
async function processBatch(batchSize: number): Promise<Quote[]> {
  const quotes: Quote[] = [];

  for (let i = 0; i < batchSize; i++) {
    const quote = await processQuote(i + 1, batchSize);
    quotes.push(quote);
  }

  return quotes;
}

// Create the traced handler with timer trigger type
const traced = createTracedHandler(
  "quote-generator",
  completionHandler,
  (event: unknown, context: LambdaContext) => {
    const baseAttributes = defaultExtractor(event, context);
    return {
      ...baseAttributes,
      trigger: TriggerType.Timer,
      spanName: "generate-quotes",
      attributes: {
        ...baseAttributes.attributes,
        "schedule.period": "5m",
      },
    };
  },
);

interface LambdaResponse {
  statusCode: number;
  body: string;
}

// Lambda handler
export const handler = traced(
  async (
    event: ScheduledEvent,
    context: LambdaContext,
  ): Promise<LambdaResponse> => {
    // Get current span to add custom attributes
    const currentSpan = trace.getActiveSpan();

    currentSpan?.addEvent("Lambda Invocation Started", {
      "log.severity": "info",
      "log.message": "Lambda function invocation started",
    });

    try {
      const batchSize = Math.floor(Math.random() * 10) + 1;
      currentSpan?.setAttribute("batch.size", batchSize);

      const quotes = await processBatch(batchSize);

      currentSpan?.addEvent("Batch Processing Completed", {
        "log.severity": "info",
        "log.message": `Successfully processed batch of ${batchSize} quotes`,
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Retrieved and sent ${batchSize} random quotes to SQS`,
          input: event,
          quotes,
        }),
      };
    } catch (error) {
      currentSpan?.recordException(error as Error);
      currentSpan?.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    }
  },
);
