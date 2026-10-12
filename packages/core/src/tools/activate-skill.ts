/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFolderStructure } from '../utils/getFolderStructure.js';
import { isSubpath } from '../utils/paths.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type {
  ToolResult,
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolConfirmationOutcome,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';
import { ACTIVATE_SKILL_TOOL_NAME } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import { getActivateSkillDefinition } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';

/**
 * Parameters for the ActivateSkill tool
 */
export interface ActivateSkillToolParams {
  /**
   * The name of the skill to activate
   */
  name: string;
}

class ActivateSkillToolInvocation extends BaseToolInvocation<
  ActivateSkillToolParams,
  ToolResult
> {
  private cachedFolderStructure: string | undefined;

  constructor(
    private config: Config,
    params: ActivateSkillToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const skillName = this.params.name;
    const skill = this.config.getSkillManager().getSkill(skillName);
    if (skill) {
      return `"${skillName}": ${skill.description}`;
    }
    return `"${skillName}" (?) unknown skill`;
  }

  private async getOrFetchFolderStructure(
    skillLocation: string,
  ): Promise<string> {
    if (this.cachedFolderStructure === undefined) {
      this.cachedFolderStructure = await getFolderStructure(
        path.dirname(skillLocation),
      );
    }
    return this.cachedFolderStructure;
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (!this.messageBus) {
      return false;
    }

    const skillName = this.params.name;
    const skill = this.config.getSkillManager().getSkill(skillName);

    if (!skill) {
      return false;
    }

    if (skill.isBuiltin) {
      return false;
    }

    const folderStructure = await this.getOrFetchFolderStructure(
      skill.location,
    );

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Activate Skill: ${skillName}`,
      prompt: `You are about to enable the specialized agent skill **${skillName}**.

**Description:**
${skill.description}

**Resources to be shared with the model:**
${folderStructure}`,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        await this.publishPolicyUpdate(outcome);
      },
    };
    return confirmationDetails;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const skillName = this.params.name;
    const skillManager = this.config.getSkillManager();
    const skill = skillManager.getSkill(skillName);

    if (!skill) {
      const skills = skillManager.getSkills();
      const availableSkills = skills.map((s) => s.name).join(', ');
      const errorMessage = `Skill "${skillName}" not found. Available skills are: ${availableSkills}`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    skillManager.activateSkill(skillName);

    const skillDir = path.dirname(skill.location);
    if (!skillDirectoryMayJoinWorkspace(skillDir, this.config)) {
      const errorMessage = `Skill "${skillName}" resolves outside the workspace and was not added.`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    // Add the skill's directory to the workspace context so the agent has permission
    // to read its bundled resources.
    this.config.getWorkspaceContext().addDirectory(skillDir);

    const folderStructure = await this.getOrFetchFolderStructure(
      skill.location,
    );

    return {
      llmContent: `<activated_skill name="${skillName}">
  <instructions>
    ${skill.body}
  </instructions>

  <available_resources>
    ${folderStructure}
  </available_resources>
</activated_skill>`,
      returnDisplay: `Skill **${skillName}** activated. Resources loaded from \`${path.dirname(skill.location)}\`:\n\n${folderStructure}`,
    };
  }
}

/**
 * A project skill whose real path leaves the workspace must not become a
 * workspace root. Skills that already live outside the workspace (user,
 * extension, builtin) are unchanged unless their own directory is a symlink
 * to somewhere else.
 */
export function skillDirectoryMayJoinWorkspace(
  skillDir: string,
  config: Config,
): boolean {
  if (!fs.existsSync(skillDir)) {
    return true;
  }

  let realSkillDir: string;
  try {
    realSkillDir = fs.realpathSync(skillDir);
  } catch {
    return false;
  }

  const roots = config.getWorkspaceContext().getDirectories();
  const insideWorkspace = roots.some((root) => {
    try {
      return isSubpath(fs.realpathSync(root), realSkillDir);
    } catch {
      return isSubpath(path.resolve(root), realSkillDir);
    }
  });
  if (insideWorkspace) {
    return true;
  }

  // Outside the workspace: allow only a real directory. A symlink, including
  // one in an ancestor, would add the escaped target as a workspace root.
  return !pathContainsSymlink(skillDir);
}

function pathContainsSymlink(candidate: string): boolean {
  let current = path.resolve(candidate);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      // A missing component cannot itself be a symlink.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/**
 * Implementation of the ActivateSkill tool logic
 */
export class ActivateSkillTool extends BaseDeclarativeTool<
  ActivateSkillToolParams,
  ToolResult
> {
  static readonly Name = ACTIVATE_SKILL_TOOL_NAME;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    const skills = config.getSkillManager().getSkills();
    const skillNames = skills.map((s) => s.name);
    const definition = getActivateSkillDefinition(skillNames);

    super(
      ActivateSkillTool.Name,
      'Activate Skill',
      definition.base.description!,
      Kind.Other,
      definition.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ActivateSkillToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ActivateSkillToolParams, ToolResult> {
    return new ActivateSkillToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName ?? 'Activate Skill',
    );
  }

  override getSchema(modelId?: string) {
    const skills = this.config.getSkillManager().getSkills();
    const skillNames = skills.map((s) => s.name);
    return resolveToolDeclaration(
      getActivateSkillDefinition(skillNames),
      modelId,
    );
  }
}
