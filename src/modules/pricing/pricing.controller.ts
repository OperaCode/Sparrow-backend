import type { Request, RequestHandler } from "express";
import type { z } from "zod";
import { auditActor } from "../../http/middleware/authenticate.js";
import { UnauthorizedError } from "../../http/errors.js";
import { sendData } from "../../http/response.js";
import type { AuthContext } from "../../types/auth.js";
import type {
  manualQuoteBodySchema,
  orderParamsSchema,
  ruleParamsSchema,
  updateRuleBodySchema,
} from "./pricing.schema.js";
import type { PricingService } from "./pricing.service.js";
import { CURRENCY, type QuoteInput } from "./pricing.types.js";

export interface PricingController {
  quote: RequestHandler;
  createOrder: RequestHandler;
  updateRule: RequestHandler;
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
      sendData(res, await service.quote(bodyOf(req) as QuoteInput));
    },

    createOrder: async (req, res) => {
      const { userId } = requireAuth(req);
      const order = await service.createOrder(
        userId,
        bodyOf(req) as QuoteInput,
      );
      sendData(res, order, { status: 201 });
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

    applyManualQuote: async (req, res) => {
      const params = req.params as z.output<typeof orderParamsSchema>;
      const body = bodyOf(req) as z.output<typeof manualQuoteBodySchema>;
      const order = await service.applyManualQuote(
        params.id,
        body.amountNaira,
        auditActor(req),
      );
      sendData(res, order);
    },
  };
}
