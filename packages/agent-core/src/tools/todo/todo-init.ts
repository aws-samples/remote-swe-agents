import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { initializeTodoList, formatTodoListMarkdown } from '../../lib/todo';
import { fileEditTool } from '../editor';

const todoInitInputSchema = z.object({
  items: z
    .array(z.string())
    .min(1)
    .describe('Array of task descriptions to initialize the list with. All tasks are initially marked as pending.'),
});

/**
 * Tool to initialize or replace a todo list
 */
async function todoInit(params: z.infer<typeof todoInitInputSchema>) {
  const { items } = params;

  const todoList = await initializeTodoList(items);
  const formattedList = formatTodoListMarkdown(todoList);

  return formattedList;
}

const name = 'todoInit';

export const todoInitTool: ToolDefinition<z.infer<typeof todoInitInputSchema>> = {
  name,
  handler: todoInit,
  schema: todoInitInputSchema,
  toolSpec: async () => ({
    name,
    description: `Establish a fresh todo list or overwrite the current one.

This utility enables systematic workflow management during development sessions, facilitating progress monitoring and task coordination while providing transparency to users regarding work completion status.
Additionally, it enhances user comprehension of ongoing activities and overall request fulfillment.

## Optimal Usage Scenarios
Deploy this functionality strategically under these conditions:

1. Intricate workflows requiring multiple phases - Apply when operations demand 3+ sequential actions or procedures
2. Sophisticated assignments needing orchestration - Utilize for endeavors requiring methodical coordination or compound operations
3. Direct user specification for task tracking - Activate when users explicitly request task list functionality
4. Multiple assignment batches - Engage when users present enumerated or delimited work items
5. Upon instruction receipt - Promptly document user specifications as actionable items. Modify todo list as new details emerge.
6. Following task completion - Update status and incorporate subsequent follow-up activities
7. During task initiation - Transition items to active status. Maintain singular active task focus. Finalize current work before advancing to new items.

## Inappropriate Usage Contexts

Avoid this utility when:
1. Only one straightforward operation exists
2. Work is elementary and tracking offers no structural advantage
3. Completion requires fewer than 3 basic steps
4. Interaction is purely discussion-based or informational

IMPORTANT: Refrain from using this tool for single elementary tasks. Direct execution is more efficient in such cases.

## Practical Application Examples

<example>
User: I need to implement responsive design for our mobile application. Don't forget to validate everything works across different screen sizes!
Assistant: I'll implement responsive design for your mobile application. Let me establish a todo list to monitor this development.
*Establishes todo list with these items:*
1. Design responsive layout components for mobile interface
2. Configure viewport and media query management
3. Develop adaptive styling system for various screen dimensions
4. Modify existing interface elements for responsive behavior
5. Execute cross-device testing and resolve any compatibility issues
*Commences with the initial task*

<reasoning>
The assistant employed the todo list because:
1. Responsive design implementation involves multiple interconnected components requiring UI, layout, and styling modifications
2. The user specifically requested cross-device validation afterward
3. The assistant recognized the need for comprehensive testing by including "Execute cross-device testing" as the concluding task
</reasoning>
</example>

<example>
User: Assist me in refactoring the API endpoints from REST to GraphQL throughout the application
Assistant: Let me begin by analyzing your current REST API structure to identify all endpoints requiring conversion.
*Employs search utilities to discover all REST endpoint definitions across the codebase*
Assistant: I've located 12 REST endpoints distributed across 6 different modules. Let me establish a todo list to systematically manage these conversions.
*Establishes todo list with detailed items for each module requiring updates*

<reasoning>
The assistant utilized the todo list because:
1. Initially, the assistant investigated to comprehend the conversion scope
2. After discovering multiple endpoints across various modules, it recognized this as an intricate task requiring numerous sequential steps
3. The todo list ensures systematic tracking and updating of every endpoint
4. This methodology prevents overlooking any endpoints and maintains architectural consistency
</reasoning>
</example>

<example>
User: I need to implement these capabilities for my blog platform: content management, user authentication, comment system, and analytics dashboard.
Assistant: I'll assist with implementing these capabilities. First, let me establish a comprehensive todo list for all features.
*Establishes a todo list decomposing each capability into specific tasks aligned with the project structure*
Assistant: Let's begin with content management. This will require developing data models, administrative interfaces, and content rendering systems that integrate with your existing platform architecture.

<reasoning>
The assistant utilized the todo list because:
1. The user presented multiple sophisticated capabilities to implement in a structured list
2. The todo list facilitates organizing these substantial features into manageable components
3. This strategy enables progress tracking throughout the complete implementation cycle
</reasoning>
</example>

<example>
User: Could you assist with optimizing my database performance? The queries are executing slowly and causing timeout issues.
Assistant: I'll help optimize your database performance. First, let me examine your database schema and query patterns to identify potential bottlenecks.
*Analyzes table structures, indexing strategies, query execution plans, and connection management*
Assistant: Following my analysis of your database configuration, I've identified multiple performance concerns. Let me establish a todo list to systematically address these optimization opportunities.
*Establishes todo list with items such as: 1) Implement composite indexes for frequently queried columns in UserProfiles, 2) Add query result caching for Dashboard analytics, 3) Optimize join operations in ReportGeneration module, 4) Resolve N+1 query patterns in ProductCatalog, 5) Analyze connection pooling configuration and implement improvements*
Let's begin by implementing composite indexes for the frequently queried columns in your UserProfiles table.

<reasoning>
The assistant employed the todo list because:
1. First, the assistant analyzed the database to identify specific performance bottlenecks
2. Based on this examination, it discovered multiple optimization opportunities
3. Database performance optimization represents a sophisticated task requiring multiple sequential steps
4. The todo list facilitates systematic tracking of improvements across different database components
5. This methodical approach ensures comprehensive addressing of all performance bottlenecks
</reasoning>
</example>

## Scenarios Where Todo List Should Be Avoided

<example>
User: How do I display 'Hello World' in JavaScript?
Assistant: In JavaScript, you can display "Hello World" using this straightforward code:

javascript
console.log("Hello World");

This will output the text "Hello World" to the browser console when executed.

<reasoning>
The assistant avoided the todo list because this represents a single, elementary task completable in one step. There's no requirement to track multiple tasks or steps for such a direct request.
</reasoning>
</example>

<example>
User: What functionality does the npm start command provide?
Assistant: The npm start command executes the script defined in the "start" field of your package.json file. It typically launches your application's development server or runs the main application entry point. This is a standard command for initiating Node.js applications and development environments.

<reasoning>
The assistant avoided the todo list because this represents an informational inquiry with no actual development task to execute. The user is requesting an explanation, not asking the assistant to perform multiple steps or tasks.
</reasoning>
</example>

<example>
User: Could you add documentation to the processPayment function describing its purpose?
Assistant: Certainly, let me add documentation to the processPayment function explaining its functionality.
* Utilizes the ${fileEditTool.name} tool to add documentation to the processPayment function *

<reasoning>
The assistant avoided the todo list because this represents a single, direct task limited to one code location. Adding documentation doesn't require tracking multiple steps or systematic coordination.
</reasoning>
</example>

<example>
User: Execute yarn build for me and report the results.
Assistant: I'll execute the yarn build command for you.

*Executes: yarn build*

The command executed successfully. Here's the output:
[Output of yarn build command]

All project assets have been compiled according to your build configuration.

<reasoning>
The assistant avoided the todo list because this represents a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this direct operation.
</reasoning>
</example>

## Task Status Management and Workflow

1. **Status Categories**: Utilize these states for progress tracking:
   - pending: Task awaiting initiation
   - in_progress: Currently active (maintain ONE active task maximum)
   - completed: Task successfully finished
   - cancelled: Task no longer required

2. **Workflow Management**:
   - Update task status continuously during work
   - Mark tasks complete IMMEDIATELY upon finishing (avoid batching completions)
   - Maintain only ONE task in_progress simultaneously
   - Complete current tasks before initiating new ones
   - Cancel tasks that become obsolete

3. **Task Organization**:
   - Generate specific, actionable items
   - Decompose complex tasks into smaller, manageable components
   - Employ clear, descriptive task naming

When uncertain, deploy this tool. Proactive task management demonstrates diligence and ensures comprehensive requirement fulfillment.
`.trim(),
    inputSchema: { json: zodToJsonSchemaBody(todoInitInputSchema) },
  }),
};
