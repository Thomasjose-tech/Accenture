import * as dotenv from 'dotenv';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

import { CodeReviewOrchestrator } from './orchestrator';
import { ReportGenerator } from './utils/report-generator';

// Load environment variables
dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 *
 * Usage:
 * npm run dev -- <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  // Validate command line arguments
  if (!owner || !repo || !prStr) {
    console.error(
      'Usage: npm run dev -- <owner> <repo> <pr-number>'
    );
    process.exit(1);
  }

  const prNumber = Number(prStr);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('Error: PR number must be a positive integer.');
    process.exit(1);
  }

  // Validate authentication
  const hasAnthropicApiKey = Boolean(
    process.env.ANTHROPIC_API_KEY
  );

  const hasAwsCredentials =
    Boolean(process.env.AWS_ACCESS_KEY_ID) &&
    Boolean(process.env.AWS_SECRET_ACCESS_KEY);

  if (hasAwsCredentials) {
    if (!process.env.AWS_REGION) {
      console.error(
        'Error: AWS_REGION is required when using AWS Bedrock authentication.'
      );
      process.exit(1);
    }

    console.log('🔐 Using AWS Bedrock authentication');
  } else if (hasAnthropicApiKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else {
    console.error('Error: No authentication configured.');
    console.error('');
    console.error('Option 1 - Anthropic API:');
    console.error('  Set ANTHROPIC_API_KEY in your .env file.');
    console.error('');
    console.error('Option 2 - AWS Bedrock:');
    console.error('  Set AWS_ACCESS_KEY_ID');
    console.error('  Set AWS_SECRET_ACCESS_KEY');
    console.error('  Set AWS_REGION');
    process.exit(1);
  }

  // Validate model
  const model = process.env.ANTHROPIC_MODEL;

  if (!model) {
    console.error(
      'Error: ANTHROPIC_MODEL environment variable is required.'
    );
    console.error('');
    console.error(
      'Anthropic API example: claude-sonnet-4-5-20250929'
    );
    console.error(
      'AWS Bedrock example: us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
    process.exit(1);
  }

  console.log(`🤖 Using model: ${model}`);
  console.log(`🔍 Reviewing ${owner}/${repo} PR #${prNumber}`);

  try {
    // Create orchestrator
    const orchestrator = new CodeReviewOrchestrator({
      maxTurns: 20,
    });

    // Run the code review
    const report = await orchestrator.reviewPullRequest(
      owner,
      repo,
      prNumber
    );

    // Create report generator
    const reportGenerator = new ReportGenerator();

    // Generate all three report formats
    const markdownReport =
      reportGenerator.generateMarkdownReport(report);

    const htmlReport =
      reportGenerator.generateHTMLReport(report);

    const jsonReport =
      reportGenerator.generateJSONReport(report);

    // Create reports directory
    const reportsDirectory = join(process.cwd(), 'reports');

    await mkdir(reportsDirectory, {
      recursive: true,
    });

    // Generate base filename
    const baseName = `${owner}_${repo}_${prNumber}`;

    // Save Markdown report
    await writeFile(
      join(reportsDirectory, `${baseName}.md`),
      markdownReport,
      'utf-8'
    );

    // Save HTML report
    await writeFile(
      join(reportsDirectory, `${baseName}.html`),
      htmlReport,
      'utf-8'
    );

    // Save JSON report
    await writeFile(
      join(reportsDirectory, `${baseName}.json`),
      jsonReport,
      'utf-8'
    );

    console.log('');
    console.log('✅ Code review completed successfully!');
    console.log('');
    console.log('Reports generated:');
    console.log(`  📄 ${join('reports', `${baseName}.md`)}`);
    console.log(`  🌐 ${join('reports', `${baseName}.html`)}`);
    console.log(`  📋 ${join('reports', `${baseName}.json`)}`);
  } catch (error) {
    console.error('');
    console.error('❌ Code review failed.');

    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(error);
    }

    process.exit(1);
  }
}

main();