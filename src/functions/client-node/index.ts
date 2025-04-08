import { initTelemetry, createTracedHandler } from "@dev7a/lambda-otel-lite";
import type { LambdaContext } from "@dev7a/lambda-otel-lite";
import { APIGatewayProxyStructuredResultV2, ScheduledEvent } from "aws-lambda";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import { validateEnv } from "../../utils/validate-env";

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

// Initialize OpenTelemetry tracer and provider
const { tracer, completionHandler } = initTelemetry();

// Define API endpoints
const QUOTES_URL = "https://dummyjson.com/quotes/random";
const { TARGET_URL } = validateEnv(["TARGET_URL"]);

// Define the schema for quote validation
const QuoteSchema = z.object({
  id: z.number(),
  quote: z.string(),
  author: z.string(),
});
type Quote = z.infer<typeof QuoteSchema>;

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

async function lambdaHandler(
  _event: ScheduledEvent,
  _context: LambdaContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  const currentSpan = trace.getActiveSpan();

  try {
    const quote = await getRandomQuote();
    currentSpan?.addEvent("Quote Fetched Successfully", { quote_id: quote.id });

    const savedResponse = await saveQuote(quote);
    currentSpan?.addEvent("Quote Saved Successfully", { quote_id: quote.id });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Quote Processed Successfully",
        quote,
        savedResponse,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    currentSpan?.recordException(error as Error);
    currentSpan?.setStatus({ code: SpanStatusCode.ERROR });

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error processing quote",
        error: (error as Error).message,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  }
}

// Create the traced handler
const traced = createTracedHandler(
  "quotes-function",
  completionHandler,
  (event: unknown, context: LambdaContext) => {
    return {
      spanName: "process-quote",
      attributes: {
        "faas.trigger": "timer",
      },
    };
  },
);

// The handler accepts ScheduledEvent inputs and uses the lambdaHandler function
export const handler = traced(lambdaHandler);

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

/**
 * Fetches a random quote from the external API and validates its structure.
 *
 * @returns A validated Quote object
 * @throws Error if the API request fails or if the response doesn't match the schema
 */
async function getRandomQuote(): Promise<Quote> {
  return tracer.startActiveSpan("get_random_quote", async (span) => {
    try {
      const response = await fetch(QUOTES_URL);

      span.setAttributes({
        "http.url": QUOTES_URL,
        "http.method": "GET",
        "http.status_code": response.status,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return QuoteSchema.parse(data);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Saves a quote to the target endpoint with proper telemetry tracking.
 *
 * @param quote - The quote object to save
 * @returns The response from the target endpoint
 * @throws Error if the save operation fails
 */
async function saveQuote(quote: Quote): Promise<unknown> {
  return tracer.startActiveSpan("save_quote", async (span) => {
    try {
      const response = await fetch(TARGET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quote),
      });

      span.setAttributes({
        "http.url": TARGET_URL,
        "http.method": "POST",
        "http.status_code": response.status,
        "quote.id": quote.id,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
