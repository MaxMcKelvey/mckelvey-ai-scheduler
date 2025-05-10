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

async function getTaskList(taskStack: number[]) {
    const tasks = await readTasks();
    if (taskStack.length > 0) {
        return tasks.filter((task) => task.parentId === taskStack[taskStack.length - 1]);
    }
    return tasks;
}

const SubtaskResponseSchema = z.array(z.object({
    subtask: z.string(),
    priority: z.enum(["low", "medium", "high"]),
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

    const subtasks = parsedResponse.map((subtask) => {
        taskNum++;
        return {
            id: taskNum,
            parentId: task.id,
            description: subtask.subtask,
            priority: subtask.priority,
        };
    });

    return subtasks;
}

async function processTask(task: Task) {
    // TODO: Implement the task processing logic
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

async function executePrompt(prompt: string) {
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
    });
    console.log(subtasks);
}

main();
