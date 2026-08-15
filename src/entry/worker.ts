import { createApp } from "../http/app.js";
import { VERSION } from "../version.js";

const app = createApp({ version: VERSION });

export default {
  fetch: app.fetch,
};
