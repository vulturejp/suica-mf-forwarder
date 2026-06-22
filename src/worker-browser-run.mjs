import { createCloudflareBrowserPage, postReadyRowsToMoneyForward } from "./money-forward-browser-run.mjs";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Use POST with parsed Suica rows JSON", { status: 405 });
    }

    const payload = await request.json();
    const puppeteer = await import("@cloudflare/puppeteer");
    const session = await createCloudflareBrowserPage(env, puppeteer);

    try {
      const result = await postReadyRowsToMoneyForward(session.page, payload.transactions ?? [], {
        dryRun: payload.dryRun !== false,
        credentials: payload.credentials ?? {
          email: env.MF_EMAIL,
          password: env.MF_PASSWORD
        },
        env,
        suicaAccountName: payload.suicaAccountName,
        selectors: payload.selectors
      });

      return Response.json(result);
    } finally {
      await session.close();
    }
  }
};
