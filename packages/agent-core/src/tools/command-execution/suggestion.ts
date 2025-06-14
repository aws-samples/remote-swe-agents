import { ciTool } from '../ci';

export const generateSuggestion = (command: string, success: boolean): string | undefined => {
  const suggestion: string[] = [];
  if (command.toLowerCase().includes('git push')) {
    if (success) {
      suggestion.push(
        'Remember, when you push git commits to a pull request, make sure you check the CI status and fix the code until it passes.'
      );
    }
  }
  return suggestion.join('\n') || undefined;
};
