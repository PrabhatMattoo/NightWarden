// Describing the routes registers them and nothing more: no database is opened
// and no state directory is read, since no request is ever answered.
import Fastify from "fastify";
import type { OpenAPIV3_1 } from "openapi-types";
import { registerApi } from "./api.js";

export async function describeApi(): Promise<OpenAPIV3_1.Document> {
  const server = Fastify({ logger: false });
  await registerApi(server);
  await server.ready();
  // @fastify/swagger types the document as 3.0 or 3.1; registerApi asks for 3.1.
  const document = server.swagger() as OpenAPIV3_1.Document;
  await server.close();
  return document;
}
