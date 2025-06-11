import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * List of knowledge file patterns to search for
 */
export const knowledgeFilePatterns = [
  'AmazonQ.md',
  '.clinerules',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  'AGENT.md',
  'AGENTS.md',
  // Directories (ending with /)
  '.cursor/rules/',
];

/**
 * Finds all markdown files in a directory recursively
 * @param dir Directory to search in
 * @returns Array of full paths to markdown files
 */
export function findMdFiles(dir: string): string[] {
  const results: string[] = [];

  try {
    const files = readdirSync(dir);

    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);

      if (stat.isDirectory()) {
        // Recursive call for subdirectories
        results.push(...findMdFiles(filePath));
      } else if (file.toLowerCase().endsWith('.md')) {
        // Add markdown files
        results.push(filePath);
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error);
  }

  return results;
}

/**
 * Finds and reads knowledge files in a repository
 * @param repoDirectory Repository directory path
 * @returns Object containing knowledge content and whether any files were found
 */
export function findRepositoryKnowledge(repoDirectory: string): { content: string; found: boolean } {
  let knowledgeContent = '';
  let foundKnowledgeFile = false;

  for (const item of knowledgeFilePatterns) {
    const itemPath = join(repoDirectory, item);

    // Check if path exists
    if (existsSync(itemPath)) {
      // If item ends with '/', it's a directory - process all .md files
      if (item.endsWith('/')) {
        const mdFiles = findMdFiles(itemPath);
        if (mdFiles.length > 0) {
          console.log(`Found knowledge directory: ${item} with ${mdFiles.length} markdown files`);
          // Concatenate all found markdown files
          for (const mdFile of mdFiles) {
            try {
              const content = readFileSync(mdFile, 'utf-8');
              knowledgeContent += `\n\n# ${mdFile.replace(repoDirectory, '')}\n${content}`;
              foundKnowledgeFile = true;
            } catch (error) {
              console.error(`Error reading markdown file ${mdFile}:`, error);
            }
          }
        }
      } else {
        // It's a regular file
        try {
          const content = readFileSync(itemPath, 'utf-8');
          console.log(`Found knowledge file: ${item}`);
          knowledgeContent = content;
          foundKnowledgeFile = true;
          break; // Stop at first found file if it's not a directory
        } catch (error) {
          console.error(`Error reading knowledge file ${item}:`, error);
        }
      }
    }
  }

  return {
    content: knowledgeContent,
    found: foundKnowledgeFile,
  };
}
