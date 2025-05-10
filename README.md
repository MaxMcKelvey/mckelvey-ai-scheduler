# mckelvey-ai-scheduler

To install dependencies:

```bash
bun install
```

To run:

```bash
bun scheduler.ts
```

This project was created using `bun init` in bun v1.2.10. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

# Scratchpad

Self assembling code:

1. Take prompt from user
2. Generate a list of tasks to complete the prompt
3. For each tasks, generate a list of tasks to complete the task

## Each a-prompt gets fed into the categorizer

Pre:
- Feed prompt into openai api for high-quality response
- Get context and add it to the prompt
- Devide the prompt into a list of tasks
- Decide where the output should be written
Post:
- Write the output to the output location (replacing the existing content if any)
- Summarize the work that was done if inside a task

## For each task

- Decide if the task is ready to be executed
- Devide the task into a list of subtasks
- Devise an a-prompt for the task
- Delete the task from the list

