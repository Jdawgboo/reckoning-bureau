import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../agent/agent-library.ts';
import { ownerContact } from '../config-bridge.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILLS_DIR_RELATIVE_PATH = join('.agent', 'skills');
const SKILL_FILE_NAME = 'SKILL.md';

/** Skill-body placeholder for owner-notification instructions — substituted
 *  at prompt-build time, never hardcoded prose in a skill file. Owner
 *  identity is platform truth (see `ownerContact()`), not builder config. */
const OWNER_EMAIL_INSTRUCTION_PLACEHOLDER = '{{OWNER_EMAIL_INSTRUCTION}}';

function buildOwnerEmailInstruction(): string {
  const contact = ownerContact();
  if (!contact) {
    return (
      'No owner email is configured for this agent — skip the owner-notification step ' +
      'silently. Never invent an address.'
    );
  }
  return (
    `Send owner notifications to ${contact.email} using the connected email MCP tool if one ` +
    'is present in your tool list. If no such tool is available, skip the notification silently.'
  );
}

/** Substitutes registry-level values into an autoloaded skill body — the
 *  seam that keeps platform truth (owner email) out of skill-file prose. */
export function injectSkillVariables(body: string): string {
  if (!body.includes(OWNER_EMAIL_INSTRUCTION_PLACEHOLDER)) {
    return body;
  }
  return body.split(OWNER_EMAIL_INSTRUCTION_PLACEHOLDER).join(buildOwnerEmailInstruction());
}

// Mapping of skill folder names to their enable check functions
const SKILL_ENABLE_CHECKS: Record<string, () => boolean> = {};

type ParsedSkill = {
  name?: string;
  description?: string;
  autoload?: boolean;
  body?: string;
};

function findSkillsDir(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    const candidate = join(current, SKILLS_DIR_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function parseSkillFile(content: string): ParsedSkill {
  const { data, content: body } = parseFrontmatter(content);
  const autoloadRaw = data?.metadata?.autoload;

  const autoload =
    autoloadRaw === true ||
    autoloadRaw === 1 ||
    autoloadRaw === 'true' ||
    autoloadRaw === '1' ||
    autoloadRaw === 'yes';

  return {
    name: data.name,
    description: data.description,
    autoload,
    body: autoload ? body : undefined,
  };
}

function isSkillEnabled(skillFolderPath: string): boolean {
  const folderName = basename(skillFolderPath);
  const checkFn = SKILL_ENABLE_CHECKS[folderName];

  // If no check function defined, skill is always enabled
  if (!checkFn) {
    return true;
  }

  return checkFn();
}

function collectSkillFiles(dir: string, isRoot = true): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isRoot && !isSkillEnabled(fullPath)) {
        continue;
      }
      files.push(...collectSkillFiles(fullPath, false));
    } else if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      files.push(fullPath);
    }
  }

  return files;
}

export function loadSkillsPrompt(): string {
  const agentTemplateRoot = join(__dirname, '..', '..', '..', '..');
  const searchRoots = [process.cwd(), agentTemplateRoot];
  let skillsDir: string | undefined;
  for (const root of searchRoots) {
    skillsDir = findSkillsDir(root);
    if (skillsDir) {
      break;
    }
  }
  if (!skillsDir) {
    return '';
  }

  const skillFiles = collectSkillFiles(skillsDir);
  if (skillFiles.length === 0) {
    return '';
  }

  const autoloadedSections: string[] = [];
  const availableSections: string[] = [];

  for (const filePath of skillFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseSkillFile(content);
      const header = parsed.name ? `Skill: ${parsed.name}` : `Skill: ${filePath}`;
      const descriptionLine = parsed.description ? `Description: ${parsed.description}` : '';
      // Agent filesystem tool addresses skills via the `source` virtual root.
      const relativePath = filePath.replace(skillsDir, '').replace(/^\//, '');
      const pathLine = `Path: source/skills/${relativePath}`;

      if (parsed.autoload) {
        const body = parsed.body ? injectSkillVariables(parsed.body) : parsed.body;
        autoloadedSections.push(
          [header, descriptionLine, pathLine, body].filter(Boolean).join('\n'),
        );
      } else {
        availableSections.push([header, descriptionLine, pathLine].filter(Boolean).join('\n'));
      }
    } catch (error) {
      console.warn(`[SkillsLoader] Failed to read skill file: ${filePath}`, error);
    }
  }

  if (autoloadedSections.length === 0 && availableSections.length === 0) {
    return '';
  }

  const autoloadedContent = autoloadedSections.join('\n\n');
  const availableContent = availableSections.join('\n\n');

  const skillsIntro = `You have access to specialized skills that provide instructions, tool guidance, and workflows. Always check the skills listed below before starting any task.

There are two types of skills:

1. **Auto-loaded skills** — Their bodies are already below; no file read is needed to obtain them.

2. **Available skills** — Only metadata is listed below. When a request matches a skill, read its body with the filesystem tool before answering unless it is already available in context and needs no refresh. General knowledge does not replace a matching skill's instructions.

### After loading a skill

1. Follow the skill's instructions faithfully as your primary directive for the task.
2. Resolve relative references from the directory of the skill's Path: references/policies.md in source/skills/studio/SKILL.md becomes source/skills/studio/references/policies.md. Pass the complete address to the filesystem tool.
3. Load referenced material when needed for the task. Reuse authoritative content available in context; retrieve it again when missing or when freshness needs verification.`;

  const sections: string[] = [`<skills>`, skillsIntro];

  if (autoloadedSections.length > 0) {
    sections.push('', `<auto_loaded_skills>`, autoloadedContent, `</auto_loaded_skills>`);
  }

  if (availableSections.length > 0) {
    sections.push('', `<available_skills>`, availableContent, `</available_skills>`);
  }

  sections.push(`</skills>`);

  return sections.join('\n');
}
