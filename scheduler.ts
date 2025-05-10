import { Ollama } from "ollama";
import { OpenAI } from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { zodTextFormat } from "openai/helpers/zod";
import { readdir, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import "dotenv/config";

let taskNum = 0;
const ollama = new Ollama();
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const TaskSchema = z.object({
    id: z.number(),
    parentId: z.number(),
    description: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    work_ledger: z.array(z.object({
        work_summary: z.string(),
    })),
    requirements_for_success: z.string(),
    completed: z.boolean(),
});
type Task = z.infer<typeof TaskSchema>;


async function createWorkDir() {
    // read the ./work directory
    const currentDir = await readdir(".");

    // if the ./work directory does not exist, create it
    if (!currentDir.includes("work")) {
        await mkdir("./work");
    }
}

async function readWorkDirTree() {
    const workDir = await readdir("./work", { recursive: true });
    // remove directories from the array
    const files = workDir.filter((item) => !item.includes("."));
    return files;
}

async function readWorkFile(fileName: string) {
    try {
        const file = await readFile("./work/" + fileName, "utf8");
        return file;
    } catch (error) {
        console.error(`Error reading file ${fileName}: ${error}`);
        return undefined;
    }
}

async function writeWorkFile(fileName: string, content: string) {
    if (fileName.includes("/")) {
        const dirPath = fileName.split("/").slice(0, -1).join("/");
        await mkdir("./work/" + dirPath, { recursive: true });
    }
    if (!fileName.includes(".")) {
        fileName += ".md";
    }
    await writeFile("./work/" + fileName, content);
}

async function deleteWorkFile(fileName: string) {
    await unlink("./work/" + fileName);
}

async function readTasks() {
    const tasks = await readWorkFile("tasks.json");
    if (tasks) {
        return JSON.parse(tasks) as Task[];
    }
    return [];
}

async function writeTasks(tasks: Task[]) {
    await writeWorkFile("tasks.json", JSON.stringify(tasks, null, 2));
}

const compareTaskPriority = (a: Task, b: Task) => {
    const priorityOrder = ["low", "medium", "high"];
    return priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority);
}

async function getTaskList(taskStack: number[]) {
    const tasks = await readTasks();
    if (taskStack.length > 0) {
        return tasks
            .filter((task) => task.parentId === taskStack[taskStack.length - 1])
            .filter((task) => task.completed === false)
            .sort(compareTaskPriority);
    }
    return tasks
        .filter((task) => task.completed === false)
        .sort(compareTaskPriority);
}

const SubtaskResponseSchema = z.array(z.object({
    subtask: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    requirements_for_success: z.string(),
}));
type SubtaskResponse = z.infer<typeof SubtaskResponseSchema>;

async function makeTaskSubtasks(task: Task) {
    const response = await ollama.chat({
        model: "gemma3:1b",
        messages: [
        {
            role: "system",
            content: `You are a task planning AI that specializes in decomposing complex tasks into smaller, executable subtasks.

Goal:
Break this task into a logically ordered list of subtasks that:

Are as atomic as possible (can be executed directly or further decomposed).

Include any dependencies or prerequisites.

Capture the purpose of the subtask clearly and concisely.

The subtask should be independantly executable without the context of the parent task. This means that you should include as much context as is necessary in each subtask description.

Only create actionable subtasks.

Subtasks should reflect a clear plan to achieve the parent task. Return your answer in structured JSON.`
        },
        {
            role: "user",
            content: task.description
        }
        ],
        format: zodToJsonSchema(SubtaskResponseSchema)
    });

    const parsedResponse = SubtaskResponseSchema.parse(JSON.parse(response.message.content));

    const subtasks: Task[] = parsedResponse.map((subtask) => {
        taskNum++;
        return {
            id: taskNum,
            parentId: task.id,
            description: subtask.subtask,
            priority: subtask.priority,
            work_ledger: [],
            completed: false,
            requirements_for_success: subtask.requirements_for_success,
        };
    });

    return subtasks;
}

const TaskProcessSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("subtasks"),
        ready: z.literal(true),
        subtasks: z.array(z.object({
            // title: z.string(),
            task_description: z.string(),
            requirements_for_success: z.string(),
            priority: z.enum(["low", "medium", "high"]),
            // prerequisites: z.array(z.string()),
        })),
    }),
    z.object({
        type: z.literal("executePrompt"),
        ready: z.literal(true),
        executePrompt: z.object({
            prompt: z.string(),
            // expectedOutput: z.string(),
            // context: z.string().optional(),
        }),
    }),
    z.object({
        type: z.literal("notReady"),
        ready: z.literal(false),
        missingDependencies: z.array(z.string()).optional(),
        reason: z.string(),
    }),
]);
type TaskProcess = z.infer<typeof TaskProcessSchema>;

async function preProcessTask(task: Task) {
    // TODO: Implement the task processing logic
    const response = await openai.responses.parse({
        model: "gpt-4o-mini",
        input: [
            {
                role: "system",
                content: `You are an AI agent responsible for managing and preparing individual tasks.

Task Description:
"${task.description}"

Work already done:
"${task.work_ledger.map((work) => work.work_summary).join("\n")}"

Your job is to:

Check if the task is ready to execute.

If not, explain what's missing.

If the task is too large, break it into subtasks with dependencies.

If ready, generate a final prompt suitable for a language model to execute.

Return your response as a JSON object matching this schema:
                `,
            },
            {
                role: "user",
                content: "Is this task ready? If so, generate the next steps to take.",
            },
        ],
        text: {
            format: zodTextFormat(TaskProcessSchema, "output")
        }
    });

    const output = response.output_parsed;
    if (!output) {
        throw new Error("No output from the model");
    }
    const parsedOutput = TaskProcessSchema.parse(output);

    return parsedOutput;
}

const PostProcessDecisionSchema = z.object({
    status: z.enum(["complete", "continue", "defer"]),
    reason: z.string().optional(),
});

async function postProcessTask(task: Task) {
    // Figure out if:
    // 1. The task has been completed
    // 2. We should continue to work on the task
    // 3. We should move on to the next task, and come back to this task later

    const response = await ollama.chat({
        model: "gemma3:1b", // or upgrade to something like "mistral:7b" for better judgment
        messages: [
          {
            role: "system",
            content: `
You are a task manager AI responsible for evaluating the state of a completed or partially completed task.

You must return a structured JSON decision in one of three categories:
- "complete" → The task is done, and no further work is needed.
- "continue" → The task is in progress, and additional steps or refinements are needed before marking it complete.
- "defer" → The task is currently blocked, and should be returned to later (e.g. due to missing context, upstream dependency, or priority shift).

Only return the structured result.
`
        },
        {
            role: "user",
            content: `
Task Description: ${task.description}
Work already done: ${task.work_ledger.map((work) => work.work_summary).join("\n")}

What do you think?
`
            },
        ],
        format: zodToJsonSchema(PostProcessDecisionSchema)
    });
    
    return PostProcessDecisionSchema.parse(JSON.parse(response.message.content));
}

async function processTask(task: Task, taskStack: number[]) {
    const preProcess = await preProcessTask(task);
    if (preProcess.type === "notReady") {
        return { next: true };
    }
    if (preProcess.type === "subtasks") {
        // create the subtasks
        const subtasks: Task[] = preProcess.subtasks.map((subtask) => {
            taskNum++;
            return {
                id: taskNum,
                parentId: task.id,
                description: subtask.task_description,
                priority: subtask.priority,
                work_ledger: [],
                completed: false,
                requirements_for_success: subtask.requirements_for_success,
            };
        });

        // save the subtasks
        const currentTasks = await readTasks();
        await writeTasks([...currentTasks, ...subtasks]);

        // add current task to the task stack
        taskStack.push(task.id);
        return { next: true };
    }
    if (preProcess.type === "executePrompt") {
        // execute the prompt
        const output = await executePrompt(preProcess.executePrompt.prompt, task.work_ledger.map((work) => work.work_summary).join("\n"));
        
        // update the task with the new work that was done
        const currentTasks = await readTasks();
        const updatedTask = currentTasks.find((t) => t.id === task.id);
        if (updatedTask) {
            updatedTask.work_ledger.push({ work_summary: output });
            await writeTasks([...currentTasks]);
        }
    }
    // do post processing
    const postProcess = await postProcessTask(task);
    if (postProcess.status === "complete") {
        // mark the task as completed
        const currentTasks = await readTasks();
        const updatedTask = currentTasks.find((t) => t.id === task.id);
        if (updatedTask) {
            updatedTask.completed = true;
            await writeTasks([...currentTasks]);
        }
        return { next: true };
    }
    if (postProcess.status === "defer") {
        return { next: true };
    }
    return { next: false };
}

async function getContext(prompt: string) {
    // fetch the dir tree
    const dirTree = await readWorkDirTree();
    // determine the files that should be included in the context with the prompt
    const relevantFileResponse = await ollama.chat({
        model: "gemma3:1b",
        messages: [
            {
                role: "system",
                content: `You are a file system explorer that specializes in determining the files that are relevant to a given prompt.

                The prompt is: ${prompt}

                The directory tree is: ${dirTree.join("\n")}
                
                Return your answer in structured JSON.`
            },
            {
                role: "user",
                content: `What files are necessary to understand the prompt? Please return a list of file paths that should be read and included in the prompt context.`
            }
        ],
        format: zodToJsonSchema(z.array(z.string()))
    })

    const relevantFiles = JSON.parse(relevantFileResponse.message.content) as string[];

    // read the files
    const fileContents = await Promise.all(relevantFiles.map(async (file) => {
        return {
            file,
            content: await readWorkFile(file),
        };
    }));

    // remove the undefined values
    const filteredFileContents = fileContents.filter((file) => file.content !== undefined);

    return filteredFileContents.map((file) => `${file.file}\n${file.content}`).join("\n\n");
}

const SaveLocationSchema = z.object({
    path: z.string(),
    reason: z.string().optional(), // Optional: helpful for logs / understanding model choices
});
type SaveLocation = z.infer<typeof SaveLocationSchema>;

async function getTaskSaveLocation(prompt: string) {
    const dirTree = await readWorkDirTree();
    const response = await ollama.chat({
        model: "gemma3:1b",
        messages: [
            {
                role: "system",
                content: `You are a planning assistant for a long-horizon AI system. 
Your job is to decide where the result of a given task should be saved.

Always return a single string that represents the target file path or storage location.
Use clean, structured, hierarchical paths. You may include folders like "chapters/", "scenes/", or "notes/" based on the task type.
Do not include explanations — just return the path.
If the task should create a new file, return the path to the new file. If the task should edit an existing file, return the path to the existing file.`
            },
            {
                role: "user",
                content: `Given the following task, determine where the result should be saved.

Task: "${prompt}"
Current file tree:
${dirTree.join("\n")}

Return a single file path string, such as "chapters/chapter_02.md" or "notes/plot_outline.md".`
            }
        ],
        format: zodToJsonSchema(SaveLocationSchema)
    });

    return SaveLocationSchema.parse(JSON.parse(response.message.content)) as SaveLocation;
}

const TextOutputSchema = z.object({
    content: z.string(),
    summary_of_work_done: z.string(),
});
type TextOutput = z.infer<typeof TextOutputSchema>;

async function executePrompt(prompt: string, workSummary: string) {
    // get the context
    const context = await getContext(prompt);

    // get the save location
    const saveLocation = await getTaskSaveLocation(prompt);
    const outputPath = saveLocation.path;

    // execute the prompt
    const response = await openai.responses.parse({
        model: "gpt-4o-mini",
        input: [
            {
                role: "system",
                content: `
                Here is the context for your task: ${context}

                Here is the work that has already been done: ${workSummary}
                
                `,
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        text: {
            format: zodTextFormat(TextOutputSchema, "output")
        }
    });

    const output = response.output_parsed;
    if (!output) {
        throw new Error("No output from the model");
    }
    const parsedOutput = TextOutputSchema.parse(output);

    // write the output to the file
    await writeWorkFile(outputPath, parsedOutput.content);

    return parsedOutput.summary_of_work_done;
}

async function main() {
    await createWorkDir();
    const taskStack = [];
    taskNum++;
    const subtasks = await makeTaskSubtasks({
        id: 1,
        parentId: 0,
        description: "Write a blog post about the benefits of using AI to plan tasks",
        priority: "high",
        work_ledger: [],
        completed: false,
        requirements_for_success: "The blog post should be written in a way that is easy to understand and follow.",
    });
    console.log(subtasks);
}

main();
