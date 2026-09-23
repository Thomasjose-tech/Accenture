import {
  query,
  type AgentDefinition,
} from '@anthropic-ai/claude-agent-sdk';

import { ReviewReport } from './types/report-types';
import { ReviewReportJSONSchema } from './types/report-types';
import { mcpServersConfig } from './config/mcp.config';

import { codeQualityAnalyzer } from './agents/code-quality-analyzer';
import { testCoverageAnalyzer } from './agents/test-coverage-analyzer';
import { refactoringSuggester } from './agents/refactoring-suggester';

import { buildOrchestratorPrompt } from './prompts/orchestrator.prompt';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  maxTurns?: number;
}

/**
 * Main Code Review Orchestrator
 *
 * Coordinates the three specialized subagents:
 * - Code Quality Analyzer
 * - Test Coverage Analyzer
 * - Refactoring Suggester
 */
export class CodeReviewOrchestrator {
  private readonly options: OrchestratorOptions;

  private readonly agents: Record<string, AgentDefinition> = {
    'code-quality-analyzer': codeQualityAnalyzer,
    'test-coverage-analyzer': testCoverageAnalyzer,
    'refactoring-suggester': refactoringSuggester,
  };

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
  }

  /**
   * Review a pull request using parallel subagent analysis
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startTime = Date.now();

    const prompt = buildOrchestratorPrompt(
      owner,
      repo,
      prNumber
    );

    const result = query({
      prompt,
      options: {
        mcpServers: mcpServersConfig,

        agents: this.agents,

        allowedTools: [
          'Task',
          'mcp__github__pull_request_read',
        ],

        maxTurns: this.options.maxTurns ?? 20,

        outputFormat: {
          type: 'json_schema',
          schema: ReviewReportJSONSchema,
        },
      },
    });

    for await (const message of result) {
      if (
        message.type === 'result' &&
        message.subtype === 'success' &&
        message.structured_output
      ) {
        const report = message.structured_output as ReviewReport;

        report.metadata = {
          ...report.metadata,
          analyzedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
        };

        return report;
      }
    }

    throw new Error(
      'Code review completed without producing a structured review report.'
    );
  }
}