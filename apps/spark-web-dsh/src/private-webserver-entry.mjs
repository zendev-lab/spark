import WebServer from "@deepseek-ai/dsh-host-webserver";

import {
  createSparkPrivateWebServerClass,
  takeSparkWebDshProxyCredential,
} from "./private-webserver.ts";

export default createSparkPrivateWebServerClass(WebServer, takeSparkWebDshProxyCredential());
