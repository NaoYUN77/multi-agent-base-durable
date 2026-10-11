import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  AssistantEntry,
  Harness,
  MemoryStorage,
  createRegistry,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const models = createModels();

// The provider reads OPENAI_API_KEY from the environment. The probe intentionally
// uses MemoryStorage so the first run is small and has no filesystem side effects.
models.setProvider(openaiProvider());

const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry() },
  context,
);

try {
  const conversation = await harness.root(
    context,
    { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } },
  );
  const submission = await conversation.submit(
    { type: "input", content: "用一句话说明你能做什么。" },
    context,
  );
  const settled = await submission.wait(context);

  if (settled.status === "done" && settled.type === "input") {
    const answer = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      context,
    );
    console.log(answer?.model?.[0] ?? "(no model answer)");
  } else {
    console.error("Submission did not finish with an answer:", settled);
    process.exitCode = 1;
  }
} finally {
  await harness.close(context);
}

