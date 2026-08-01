import rawPrompts from "../prompts/ai-prompts.json" with { type: "json" };

export type PromptMode = "normal" | "freeform";
export type AiPersonality =
  | "normal"
  | "weird"
  | "formal"
  | "archaic"
  | "technical";

type PromptGenerationPrompt = {
  instructions: string[];
  input: string;
  schemaDescriptions: {
    word: string;
    correctDefinition: string;
  };
};

type AiDefinitionPrompt = {
  instructions: string[];
  inputLabel: string;
  existingLabel: string;
};

type PersonalityPrompt = {
  label: string;
  direction: string;
};

type AiPrompts = {
  promptGeneration: Record<PromptMode, PromptGenerationPrompt>;
  aiDefinitions: Record<PromptMode, AiDefinitionPrompt>;
  personalities: Record<PromptMode, Record<AiPersonality, PersonalityPrompt>>;
};

const promptModes: PromptMode[] = ["normal", "freeform"];
const aiPersonalities: AiPersonality[] = [
  "normal",
  "weird",
  "formal",
  "archaic",
  "technical",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`AI prompt config error: ${path} must be an object`);
  }
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `AI prompt config error: ${path} must be a non-empty string`,
    );
  }
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(
      `AI prompt config error: ${path} must be a non-empty string array`,
    );
  }
  return value;
}

function readPromptGeneration(
  value: unknown,
  path: string,
): PromptGenerationPrompt {
  const record = readRecord(value, path);
  const schemaDescriptions = readRecord(
    record.schemaDescriptions,
    `${path}.schemaDescriptions`,
  );

  return {
    instructions: readStringArray(record.instructions, `${path}.instructions`),
    input: readString(record.input, `${path}.input`),
    schemaDescriptions: {
      word: readString(
        schemaDescriptions.word,
        `${path}.schemaDescriptions.word`,
      ),
      correctDefinition: readString(
        schemaDescriptions.correctDefinition,
        `${path}.schemaDescriptions.correctDefinition`,
      ),
    },
  };
}

function readAiDefinition(value: unknown, path: string): AiDefinitionPrompt {
  const record = readRecord(value, path);
  return {
    instructions: readStringArray(record.instructions, `${path}.instructions`),
    inputLabel: readString(record.inputLabel, `${path}.inputLabel`),
    existingLabel: readString(record.existingLabel, `${path}.existingLabel`),
  };
}

function readPersonality(value: unknown, path: string): PersonalityPrompt {
  const record = readRecord(value, path);
  return {
    label: readString(record.label, `${path}.label`),
    direction: readString(record.direction, `${path}.direction`),
  };
}

function loadAiPrompts(value: unknown): AiPrompts {
  const root = readRecord(value, "prompts");
  const promptGenerationRoot = readRecord(
    root.promptGeneration,
    "prompts.promptGeneration",
  );
  const aiDefinitionsRoot = readRecord(
    root.aiDefinitions,
    "prompts.aiDefinitions",
  );
  const personalitiesRoot = readRecord(
    root.personalities,
    "prompts.personalities",
  );

  const promptGeneration = {} as Record<PromptMode, PromptGenerationPrompt>;
  const aiDefinitions = {} as Record<PromptMode, AiDefinitionPrompt>;
  const personalities = {} as Record<
    PromptMode,
    Record<AiPersonality, PersonalityPrompt>
  >;

  for (const mode of promptModes) {
    promptGeneration[mode] = readPromptGeneration(
      promptGenerationRoot[mode],
      `prompts.promptGeneration.${mode}`,
    );
    aiDefinitions[mode] = readAiDefinition(
      aiDefinitionsRoot[mode],
      `prompts.aiDefinitions.${mode}`,
    );

    const personalityRoot = readRecord(
      personalitiesRoot[mode],
      `prompts.personalities.${mode}`,
    );
    personalities[mode] = {} as Record<AiPersonality, PersonalityPrompt>;
    for (const personality of aiPersonalities) {
      personalities[mode][personality] = readPersonality(
        personalityRoot[personality],
        `prompts.personalities.${mode}.${personality}`,
      );
    }
  }

  return {
    promptGeneration,
    aiDefinitions,
    personalities,
  };
}

const aiPrompts = loadAiPrompts(rawPrompts);

export function getPromptGenerationPrompt(mode: PromptMode) {
  return aiPrompts.promptGeneration[mode];
}

export function getAiDefinitionPrompt(
  mode: PromptMode,
  personality: AiPersonality,
) {
  const base = aiPrompts.aiDefinitions[mode];
  const personalityPrompt = aiPrompts.personalities[mode][personality] ??
    aiPrompts.personalities[mode].normal;

  return {
    instructions: [
      ...base.instructions,
      `あなたの個性: ${personalityPrompt.label}`,
      personalityPrompt.direction,
    ].join("\n"),
    inputLabel: base.inputLabel,
    existingLabel: base.existingLabel,
  };
}
