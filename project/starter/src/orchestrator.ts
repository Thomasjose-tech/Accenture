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

import {
  withRetry,
  withTimeout,
  ReviewError,
  ErrorCodes,
} from './utils/error-handler';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  maxTurns?: number;
  /** Max time for one review attempt, in ms (default: 5 minutes) */
  timeoutMs?: number;
  /** Number of attempts before giving up (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms (default: 1000) */
  retryDelayMs?: number;
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
   * Review a pull request using parallel subagent analysis.
   *
   * Each attempt is bounded by a timeout, and transient failures
   * are retried with exponential backoff.
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

    const prompt = buildOrchestratorPrompt(owner, repo, prNumber);

    const timeoutMs = this.options.timeoutMs ?? 300_000;
    const maxRetries = this.options.maxRetries ?? 3;
    const retryDelayMs = this.options.retryDelayMs ?? 1000;

    const report = await withRetry(
      () =>
        withTimeout(
          () => this.runReviewQuery(prompt),
          timeoutMs,
          `Code review timed out after ${timeoutMs}ms`
        ),
      maxRetries,
      retryDelayMs
    );

    report.metadata = {
      ...report.metadata,
      analyzedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };

    return report;
  }

  /**
   * Run a single review query and collect the structured report.
   * Kept separate so retry/timeout wrap exactly one attempt.
   */
  private async runReviewQuery(prompt: string): Promise<ReviewReport> {
    const result = query({
      prompt,
      options: {
        mcpServers: mcpServersConfig,

        agents: this.agents,

        allowedTools: ['Task', 'mcp__github__pull_request_read'],

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
        return message.structured_output as ReviewReport;
      }
    }

    throw new ReviewError(
      'Code review completed without producing a structured review report.',
      ErrorCodes.STRUCTURED_OUTPUT_FAILED
    );
  }
}