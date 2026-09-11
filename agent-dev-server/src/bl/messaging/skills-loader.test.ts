import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectSkillVariables, loadSkillsPrompt } from './skills-loader.ts';

const ENV_KEY = 'AGENT_OWNER_EMAIL';
const originalValue = process.env[ENV_KEY];

function restoreEnv(): void {
  if (originalValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalValue;
  }
}

describe('injectSkillVariables — owner-email placeholder', () => {
  afterEach(restoreEnv);

  it('substitutes the configured owner email for the placeholder', () => {
    process.env[ENV_KEY] = 'owner@example.com';
    const out = injectSkillVariables('Notify: {{OWNER_EMAIL_INSTRUCTION}} done.');
    assert.ok(out.includes('Send owner notifications to owner@example.com'));
    assert.ok(!out.includes('{{OWNER_EMAIL_INSTRUCTION}}'), 'placeholder must not leak');
  });

  it('degrades gracefully when no owner email is configured', () => {
    delete process.env[ENV_KEY];
    const out = injectSkillVariables('Notify: {{OWNER_EMAIL_INSTRUCTION}} done.');
    assert.ok(out.includes('No owner email is configured for this agent'));
    assert.ok(!out.includes('{{OWNER_EMAIL_INSTRUCTION}}'));
  });

  it('leaves a body without the placeholder unchanged', () => {
    const body = 'A skill with no owner-email placeholder.';
    assert.strictEqual(injectSkillVariables(body), body);
  });
});

describe('loadSkillsPrompt', { concurrency: false }, () => {
  let originalCwd: string;
  let fixtureRoot: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    fixtureRoot = mkdtempSync(join(tmpdir(), 'skills-loader-'));
    mkdirSync(join(fixtureRoot, '.agent', 'skills'), { recursive: true });
    process.chdir(fixtureRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
    restoreEnv();
  });

  function writeSkill(folder: string, name: string, autoload: boolean, body: string): string {
    const directory = join(fixtureRoot, '.agent', 'skills', folder);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Guidance for ${name}.\nmetadata:\n  autoload: ${autoload}\n---\n\n${body}`,
    );
    return directory;
  }

  it('gives an autoloaded body its runtime origin without loading its references', () => {
    const body = 'Read [policies](references/policies.md) when needed.';
    const directory = writeSkill('studio', 'studio', true, body);
    mkdirSync(join(directory, 'references'));
    writeFileSync(join(directory, 'references', 'policies.md'), 'REFERENCE_ONLY_CONTENT');

    const prompt = loadSkillsPrompt();

    assert.deepStrictEqual(prompt.match(/^Path: .+$/gm), ['Path: source/skills/studio/SKILL.md']);
    assert.ok(prompt.includes(body));
    assert.ok(!prompt.includes('REFERENCE_ONLY_CONTENT'));
    assert.ok(!prompt.includes(fixtureRoot));
  });

  it('advertises an on-demand skill without including its body', () => {
    writeSkill('policy', 'policy', false, 'ON_DEMAND_BODY');

    const prompt = loadSkillsPrompt();

    assert.ok(prompt.includes('Skill: policy\nDescription: Guidance for policy.'));
    assert.deepStrictEqual(prompt.match(/^Path: .+$/gm), ['Path: source/skills/policy/SKILL.md']);
    assert.ok(!prompt.includes('ON_DEMAND_BODY'));
    assert.ok(!prompt.includes('<auto_loaded_skills>'));
  });

  it('derives nested origins from the file location rather than the display name', () => {
    writeSkill('studio/visiting', 'different-display-name', true, 'Nested guidance.');

    const prompt = loadSkillsPrompt();

    assert.ok(prompt.includes('Skill: different-display-name'));
    assert.deepStrictEqual(prompt.match(/^Path: .+$/gm), [
      'Path: source/skills/studio/visiting/SKILL.md',
    ]);
  });

  it('keeps each origin in the appropriate autoloaded or available section', () => {
    writeSkill('studio', 'studio', true, 'STUDIO_BODY');
    writeSkill('policy', 'policy', false, 'POLICY_BODY');

    const prompt = loadSkillsPrompt();
    const autoloaded = prompt.split('<auto_loaded_skills>')[1]?.split('</auto_loaded_skills>')[0];
    const available = prompt.split('<available_skills>')[1]?.split('</available_skills>')[0];

    assert.ok(autoloaded);
    assert.ok(available);
    assert.deepStrictEqual(autoloaded.match(/^Path: .+$/gm), [
      'Path: source/skills/studio/SKILL.md',
    ]);
    assert.ok(autoloaded.includes('STUDIO_BODY'));
    assert.deepStrictEqual(available.match(/^Path: .+$/gm), [
      'Path: source/skills/policy/SKILL.md',
    ]);
    assert.ok(!available.includes('POLICY_BODY'));
  });

  it('still substitutes owner contact instructions in an autoloaded body', () => {
    process.env[ENV_KEY] = 'owner@example.com';
    writeSkill('contact', 'contact', true, 'Notify: {{OWNER_EMAIL_INSTRUCTION}}');

    const prompt = loadSkillsPrompt();

    assert.ok(prompt.includes('Path: source/skills/contact/SKILL.md'));
    assert.ok(prompt.includes('Send owner notifications to owner@example.com'));
    assert.ok(!prompt.includes('{{OWNER_EMAIL_INSTRUCTION}}'));
  });

  it('returns no skill prompt for an empty skills directory', () => {
    assert.strictEqual(loadSkillsPrompt(), '');
  });
});
