import { ciTool } from '../ci';

export const generateSuggestion = (command: string, success: boolean): string | undefined => {
  const suggestion: string[] = [];
  if (command.toLowerCase().includes('gh pr create')) {
    if (success) {
      suggestion.push(
        `Remember, when you successfully created a PR, make sure you report its URL to the user. Also check the CI status by using ${ciTool.name} tool and fix the code until it passes.`,
        `Please verify that your PR formatting is not broken. It's recommended to use heredoc syntax for proper markdown rendering:

   gh pr edit --body "$(cat <<EOF
   # Heading

   Description text
   
   ## Changes
   
   * Item 1
   * Item 2
   EOF
   )"`
      );
    }
  }
  if (command.toLowerCase().includes('git push')) {
    if (success) {
      suggestion.push(
        'Remember, when you push git commits, make sure you check the CI status and fix the code until it passes.'
      );
    }
  }
  return suggestion.join('\n') || undefined;
};
