const DEFAULT_VERIFICATION_CODE_KEY = "suica-mf-vericode";

export default {
  async email(message, env) {
    await handleOtpEmail(message, env);
  }
};

export async function handleOtpEmail(message, env) {
  const forwardTo = env.FORWARD_TO_EMAIL;
  if (!forwardTo) {
    throw new Error("FORWARD_TO_EMAIL is required so non-OTP email is not dropped");
  }

  try {
    const rawBytes = await new Response(message.raw).arrayBuffer();
    const body = await decodeEmailBody(rawBytes);
    const code = extractVerificationCode(body);

    if (code) {
      await env.SUICA_MF_KV.put(DEFAULT_VERIFICATION_CODE_KEY, code, { expirationTtl: 600 });
    }
  } catch (error) {
    console.error("Failed to extract/store Money Forward verification code", error);
  }

  await message.forward(forwardTo);
}

export function extractVerificationCode(body) {
  const match = body.match(/認証コード：(?:|\s)*(\d+)/) ?? body.match(/verification code(?:|\s)*[:：](?:|\s)*(\d+)/i);
  return match?.[1] ?? null;
}

async function decodeEmailBody(rawBytes) {
  try {
    const { default: PostalMime } = await import("postal-mime");
    const parsed = await PostalMime.parse(rawBytes);
    return parsed.html || parsed.text || new TextDecoder().decode(rawBytes);
  } catch {
    return new TextDecoder().decode(rawBytes);
  }
}
