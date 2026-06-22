import uploadUiWorker from "./worker-upload-ui.mjs";
import otpReceiverWorker from "./worker-otp-receiver.mjs";

export default {
  fetch: (request, env, ctx) => uploadUiWorker.fetch(request, env, ctx),
  email: otpReceiverWorker.email
};
