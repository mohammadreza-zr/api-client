/** Compile-time checks for plugin typing: `npm run typecheck` fails if these stop holding. */
import { createClient, type ApiPlugin } from "../../src/index";
import { services } from "../../src/plugins/services";

const api = createClient({
  baseUrl: "https://api.example.com",
  plugins: [services({ files: "https://files.example.com", maps: { baseUrl: "https://maps.example.com", auth: false } })],
});

void api.service("files").get<{ id: number }[]>("/uploads");
void api.service("maps");
// @ts-expect-error a typo in a service name is a compile error
void api.service("fiels");

const plain = createClient({ baseUrl: "https://api.example.com" });
// @ts-expect-error without the plugin there is no `service`
void plain.service;

const greeter: ApiPlugin<{ hello(): string }> = { name: "hello", extend: () => ({ hello: () => "hi" }) };
const both = createClient({ plugins: [greeter, services({ files: "https://files.example.com" })] });
const greeting: string = both.hello();
void greeting;
void both.service("files");
