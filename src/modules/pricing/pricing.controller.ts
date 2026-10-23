import type { Request, RequestHandler } from "express";
import type { z } from "zod";
import { UnauthorizedError } from "../../http/errors.js";
import { auditActor } from "../../http/middleware/authenticate.js";
import { IDEMPOTENCY_REPLAYED_HEADER } from "../../http/middleware/idempotency.js";
import { sendData } from "../../http/response.js";
import type { AuthContext } from "../../types/auth.js";
import type {
  areaBodySchema,
  areaParamsSchema,
  manualQuoteBodySchema,
  orderParamsSchema,
  ruleParamsSchema,
  updateRuleBodySchema,
} from "./pricing.schema.js";
import type { PricingService } from "./pricing.service.js";
import { CURRENCY, type QuoteRequest } from "./pricing.types.js";

export interface PricingController {
  quote: RequestHandler;
  createOrder: RequestHandler;
  updateRule: RequestHandler;
  updateArea: RequestHandler;
  applyManualQuote: RequestHandler;
}

function requireAuth(req: Request): AuthContext {
  if (req.auth === undefined) throw new UnauthorizedError();
  return req.auth;
}

/** validate() has already replaced the body with the parsed schema output. */
function bodyOf(req: Request): unknown {
  return req.body;
}

export function createPricingController(
  service: PricingService,
): PricingController {
  return {
    quote: async (req, res) => {
      sendData(res, await service.quote(bodyOf(req) as QuoteRequest));
    },

    createOrder: async (req, res) => {
      const { userId } = requireAuth(req);
      const claim = req.idempotency;
      if (claim === undefined) {
        throw new Error("createOrder requires an idempotency claim");
      }
      const result = await service.createOrder(
        userId,
        bodyOf(req) as QuoteRequest,
        claim,
      );
      if (result.outcome === "replay") {
        res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");
        res.status(result.statusCode).json(result.body);
        return;
      }
      sendData(res, result.order, { status: 201 });
    },

    updateRule: async (req, res) => {
      const params = req.params as z.output<typeof ruleParamsSchema>;
      const patch = bodyOf(req) as z.output<typeof updateRuleBodySchema>;
      const rule = await service.updateRule(
        params.component,
        params.tier,
        patch,
        auditActor(req),
      );
      sendData(res, { ...rule, currency: CURRENCY });
    },

    updateArea: async (req, res) => {
      const params = req.params as z.output<typeof areaParamsSchema>;
      const box = bodyOf(req) as z.output<typeof areaBodySchema>;
      const area = await service.updateArea(params.place, box, auditActor(req));
      sendData(res, area);
    },

    applyManualQuote: async (req, res) => {
      const params = req.params as z.output<typeof orderParamsSchema>;
      const body = bodyOf(req) as z.output<typeof manualQuoteBodySchema>;
      const order = await service.applyManualQuote(
        params.id,
        body.amountKobo,
        auditActor(req),
      );
      sendData(res, order);
    },
  };
}
