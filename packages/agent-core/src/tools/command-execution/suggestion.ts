import { ciTool } from '../ci';

export const generateSuggestion = (command: string, success: boolean): string | undefined => {
  const suggestion: string[] = [];
  if (command.toLowerCase().includes('gh pr create')) {
    if (success) {
      suggestion.push(
        `Remember, when you successfully created a PR, make sure you report its URL to the user. Also check the CI status by using ${ciTool.name} tool and fix the code until it passes.`
      );
    }
  }
  if (command.toLowerCase().includes('git push')) {
    if (success) {
      suggestion.push(
        'Remember, when you pushed commits to a git pull request, make sure you check the CI status and fix the code until it passes.'
      );
    }
  }
  return suggestion.join('\n') || undefined;
};
