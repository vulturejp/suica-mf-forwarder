import assert from "node:assert/strict";
import { test } from "node:test";
import { extractVerificationCode, handleOtpEmail } from "../src/worker-otp-receiver.mjs";

test("extracts Japanese Money Forward verification codes", () => {
  assert.equal(extractVerificationCode("認証コード： 123456"), "123456");
});

test("stores OTP and forwards the original email", async () => {
  const message = makeMessage("認証コード： 123456");
  const env = makeEnv();

  await handleOtpEmail(message, env);

  assert.equal(env.stored.key, "suica-mf-vericode");
  assert.equal(env.stored.value, "123456");
  assert.equal(env.stored.options.expirationTtl, 600);
  assert.equal(message.forwardedTo, "me@example.test");
});

test("forwards non-OTP email without storing a code", async () => {
  const message = makeMessage("hello");
  const env = makeEnv();

  await handleOtpEmail(message, env);

  assert.equal(env.stored, null);
  assert.equal(message.forwardedTo, "me@example.test");
});

test("still forwards email if OTP storage fails", async () => {
  const message = makeMessage("認証コード： 123456");
  const env = makeEnv({ failPut: true });

  const originalError = console.error;
  console.error = () => {};
  try {
    await handleOtpEmail(message, env);
  } finally {
    console.error = originalError;
  }

  assert.equal(message.forwardedTo, "me@example.test");
});

function makeMessage(body) {
  return {
    raw: body,
    forwardedTo: null,
    forward: async function forward(to) {
      this.forwardedTo = to;
    }
  };
}

function makeEnv(options = {}) {
  const env = {
    FORWARD_TO_EMAIL: "me@example.test",
    stored: null,
    SUICA_MF_KV: {
      put: async (key, value, putOptions) => {
        if (options.failPut) throw new Error("KV unavailable");
        env.stored = { key, value, options: putOptions };
      }
    }
  };
  return env;
}
