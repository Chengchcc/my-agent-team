/** Product Tool manifest (ADR 0003 decision 6): the fixed tool definitions
 *  the oma exposes over MCP. The SAME manifest is
 *  - persisted per run at first dispatch (product-tools MCP authorizes calls
 *    against the run's declared tools),
 *  - written into the agent workspace (`.oma/product-tools.json`) so the
 *    child builds its tool table from cwd files, not the run input.
 *  `entrypoint` is the deployment's product-tools MCP URL/executable. */
export interface ProductToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly entrypoint: string;
}

export function buildHistoryTools(entrypoint: string): readonly ProductToolDescriptor[] {
  return [
    {
      name: "artifact_upload",
      description:
        "Upload a single artifact file into backend artifact storage. Returns an artifacts://<folder>/<filename> URL that other agents (or this conversation) can download. Use this to hand off produced files to later workflow steps.",
      inputSchema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Logical folder (can be nested, e.g. report/2026)",
          },
          filename: { type: "string", description: "File name, e.g. quality.md" },
          content: {
            type: "string",
            description: "File content (UTF-8 text, or base64 when encoding=base64)",
          },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8" },
        },
        required: ["folder", "filename", "content"],
      },
      entrypoint,
    },
    {
      name: "artifact_download",
      description:
        "Download an artifact file from backend artifact storage by its artifacts://<folder>/<filename> URL. Returns the content (or base64 when the file is binary).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "artifacts://<folder>/<filename>" },
        },
        required: ["url"],
      },
      entrypoint,
    },
    {
      name: "history_recent",
      description:
        "Read the most recent messages visible to this agent member in the conversation. Returns the last N messages with their ledger seq and role.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      entrypoint,
    },
    {
      name: "history_search",
      description:
        "Search the conversation ledger for messages matching a keyword. Scoped to this run's conversation only.",
      inputSchema: {
        type: "object",
        properties: { keyword: { type: "string" }, limit: { type: "number" } },
        required: ["keyword"],
      },
      entrypoint,
    },
    {
      name: "history_around",
      description:
        "Read messages around a ledger seq in this conversation (context window before and after).",
      inputSchema: {
        type: "object",
        properties: {
          seq: { type: "number" },
          before: { type: "number" },
          after: { type: "number" },
        },
        required: ["seq"],
      },
      entrypoint,
    },
    {
      name: "history_retain",
      description:
        "Pin a conversation message into this agent's context branch so later runs keep it. Semantic mutation; replay-safe.",
      inputSchema: {
        type: "object",
        properties: { seq: { type: "number" }, reason: { type: "string" } },
        required: ["seq"],
      },
      entrypoint,
    },
    {
      name: "todo_write",
      description:
        "Replace this run's task list (durable, shown in the product UI). Pass the full desired list as items: [{id: string, text: string, status: pending | in_progress | done}]. The product injects your current list as Current Tasks in the system prompt.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
              },
              required: ["id", "text", "status"],
            },
          },
        },
        required: ["items"],
      },
      entrypoint,
    },
    {
      name: "remind_me",
      description:
        'Schedule a one-shot reminder in this conversation. At fireAt (epoch ms, must be future) the product posts the text here and a run voices it. Use for "remind me in 30 minutes / tomorrow 9am" style requests and for your own periodic maintenance nudges.',
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What the reminder says" },
          fireAt: { type: "number", description: "Epoch ms when it fires (future)" },
          recurrence: {
            type: "string",
            description:
              "Optional 5-field cron expression for recurring wake-ups; omit for one-shot",
          },
        },
        required: ["text", "fireAt"],
      },
      entrypoint,
    },
    {
      name: "reminder_list",
      description:
        "List your own pending reminders (one-shot and recurring) with ids, schedules and texts.",
      inputSchema: { type: "object", properties: {}, required: [] },
      entrypoint,
    },
    {
      name: "reminder_cancel",
      description: "Cancel one of your pending reminders by id (from reminder_list).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The reminder id" } },
        required: ["id"],
      },
      entrypoint,
    },
    {
      name: "wiki_read",
      description: "Read one wiki page (frontmatter + body + revision).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      entrypoint,
    },
    {
      name: "wiki_query",
      description: "Search the wiki by title/body substring.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, limit: { type: "number" } },
      },
      entrypoint,
    },
    {
      name: "wiki_create",
      description: "Create a new wiki page with sources.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          status: { type: "string", enum: ["draft", "confirmed", "superseded"] },
          sources: { type: "array", items: { type: "string" } },
          supersedes: { type: "array", items: { type: "string" } },
        },
        required: ["path", "title", "content"],
      },
      entrypoint,
    },
    {
      name: "wiki_patch",
      description: "Update an existing page with a CAS revision.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expected_revision: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          status: { type: "string", enum: ["draft", "confirmed", "superseded"] },
          sources: { type: "array", items: { type: "string" } },
          supersedes: { type: "array", items: { type: "string" } },
        },
        required: ["path", "expected_revision"],
      },
      entrypoint,
    },
    {
      name: "wiki_lint",
      description: "Health-check the wiki.",
      inputSchema: { type: "object", properties: {} },
      entrypoint,
    },
    {
      name: "wiki_source_add",
      description: "Save raw material (conversation range by reference, or text verbatim).",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["conversation", "text"] },
          conversation_id: { type: "string" },
          from_seq: { type: "number" },
          to_seq: { type: "number" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["kind"],
      },
      entrypoint,
    },
    {
      name: "answer_worker_request",
      description: "Answer a worker's parked request, with evidence.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          call_id: { type: "string" },
          decision: { type: "string", enum: ["allow", "deny"] },
          answer: {},
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["run_id", "call_id", "evidence"],
      },
      entrypoint,
    },
    {
      name: "project_push",
      description: "Push the worktree to agent/<runId> for review.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          message: { type: "string" },
          note: { type: "string" },
        },
        required: ["project", "message"],
      },
      entrypoint,
    },
    {
      name: "project_propose",
      description:
        "Propose a project (name + repo) and who should hold it, or with project_id a change to an existing project; a human adopts.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          name: { type: "string" },
          repo_url: { type: "string" },
          default_branch: { type: "string" },
          attach_to: { type: "array", items: { type: "string" } },
        },
      },
      entrypoint,
    },
    {
      name: "project_list",
      description: "List the registered projects.",
      inputSchema: { type: "object", properties: {} },
      entrypoint,
    },
    {
      name: "project_detail",
      description:
        "Read one project with the members that hold it (repo, default branch, who is bound).",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string", description: "Project id or name" } },
        required: ["project"],
      },
      entrypoint,
    },
    {
      name: "project_attach",
      description:
        "Bind or unbind a member to a project. Changes team configuration; needs a human's approval.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id or name" },
          agent_id: { type: "string" },
          attached: { type: "boolean", description: "true attaches (default), false detaches" },
        },
        required: ["project", "agent_id"],
      },
      entrypoint,
    },
    {
      name: "requirement_track",
      description:
        "Create or update a tracked work item (requirement) for a goal worth following: multiple turns, dispatch to team members, delivery and acceptance. NOT for one-shot Q&A.",
      inputSchema: {
        type: "object",
        properties: {
          requirement_id: { type: "string", description: "Omit to create" },
          project: { type: "string" },
          title: { type: "string" },
          goal: { type: "string", description: "What done looks like" },
          background: { type: "string" },
          constraints: { type: "string" },
          expected_deliverables: { type: "string" },
          acceptance_criteria: { type: "string" },
        },
        required: ["title", "goal"],
      },
      entrypoint,
    },
    {
      name: "requirement_query",
      description:
        "Read tracked work items: one by id (with runs, verification and open requests), or the list. The resume-in-a-new-conversation path.",
      inputSchema: {
        type: "object",
        properties: {
          requirement_id: { type: "string" },
          include_closed: { type: "boolean" },
        },
      },
      entrypoint,
    },
    {
      name: "dispatch",
      description:
        "Hand a task to another agent member of this conversation (ADR 0047 room dispatch). Omit agent to let the worker pool pick: it prefers an idle worker and narrows by capability. The target becomes a member if needed, your dispatch lands in the shared ledger, and its run reports back here — the response names who took it. instruction must carry the requester's ORIGINAL words plus any constraint you were told — never a paraphrase or an implementation plan of your own; use note (max ~30 words) only for routing background.",
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Target agent id (a member, or an agent to add). Omit it to use the pool.",
          },
          capability: {
            type: "string",
            description:
              "With agent omitted: what the work needs (e.g. react, backend). Matched against worker capability cards.",
          },
          verb: {
            type: "string",
            enum: ["fix", "build", "review", "investigate", "write", "operate", "answer"],
            description:
              "What the work DOES. fix a defect, build something new, review something, investigate a cause, write content, operate an environment, or answer.",
          },
          deliverable: {
            type: "string",
            enum: ["answer", "change", "report", "state-change"],
            description: "What the human gets back.",
          },
          object: {
            type: "string",
            description: "What the work acts on, in the requester's words.",
          },
          objectKind: {
            type: "string",
            enum: ["code", "doc", "service", "data", "other"],
          },
          references: {
            type: "array",
            items: { type: "string" },
            description:
              "Ledger/memory references you resolved for this task (e.g. seq:412, issue #123).",
          },
          reversibility: {
            type: "string",
            enum: ["reversible", "irreversible"],
            description:
              "Required for operate. An irreversible operate needs the human's own authority this turn.",
          },
          slots: {
            type: "object",
            description:
              "The details that make the work executable. fix:{repro,expected,scope,acceptance}; build:{goal,scope,acceptance,constraints}; review:{target,criteria}; investigate:{question,sources,stop}; write:{audience,form,source}; operate:{environment,action,rollback}. Missing slots are rejected — ask the human for all of them at once.",
          },
          instruction: { type: "string", description: "The task, in the requester's words" },
          note: { type: "string", description: "Optional routing background, at most ~30 words" },
          identity: {
            type: "object",
            properties: {
              runId: { type: "string" },
              conversationId: { type: "string" },
              agentId: { type: "string" },
              branchId: { type: "string" },
            },
          },
        },
        required: ["instruction", "verb", "deliverable"],
      },
      entrypoint,
    },
    {
      name: "handback",
      description:
        "Return a task that was dispatched to you when it is not yours to do — wrong skill, missing access, or a request that belongs to someone else. Wakes the agent that dispatched it with your reason, in the same room. Use this instead of attempting work outside your capability or silently doing nothing. Only available when you were dispatched (your authorization is dispatch:<agent>).",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why this is not yours to do — one or two sentences",
          },
          suggestion: {
            type: "string",
            description: "Optional: who or what could take it instead",
          },
          identity: {
            type: "object",
            properties: {
              runId: { type: "string" },
              conversationId: { type: "string" },
              agentId: { type: "string" },
              branchId: { type: "string" },
            },
          },
        },
        required: ["reason"],
      },
      entrypoint,
    },
    {
      name: "remember",
      description:
        "Write one durable lesson into this agent's long-term memory. Only when the human explicitly asks; appends to .oma/memory/product.md, duplicates ignored. Only a run the human started may call this.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      entrypoint,
    },
    {
      name: "steer_worker",
      description:
        "Redirect a worker that is already running in this conversation; the message reaches it mid-turn and it keeps its context. Not a dispatch: an idle worker needs a new task. Fails explicitly when nothing is running.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          message: { type: "string" },
        },
        required: ["agent", "message"],
      },
      entrypoint,
    },
    {
      name: "cancel_worker",
      description:
        "Stop a worker that is already running in this conversation; the run settles aborted and its dispatcher is notified. reason is required. Fails explicitly when nothing is running.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          reason: { type: "string" },
        },
        required: ["agent", "reason"],
      },
      entrypoint,
    },
    {
      name: "report",
      description:
        "Talk upward to whoever dispatched this run (ADR 0059): progress is a ledger note that does not wake them; attention wakes them now; answer hands back a direct answer. Available only when you were dispatched.",
      inputSchema: {
        type: "object",
        properties: {
          purpose: { type: "string", enum: ["progress", "attention", "answer"] },
          text: { type: "string" },
          verification: {
            type: "string",
            enum: ["not_configured", "not_run", "passed", "failed"],
          },
        },
        required: ["purpose", "text"],
      },
      entrypoint,
    },
    {
      name: "team_list",
      description:
        "List the team's agents with their capability cards (ADR 0048): id, name, description and skills. Read this before dispatching to decide WHO should take a task — a card's skills say what that agent is for.",
      inputSchema: { type: "object", properties: {}, required: [] },
      entrypoint,
    },
    {
      name: "ask_question",
      description:
        "Ask the user structured questions and wait for answers. Each question needs a string id and question text, a kind of select (with options) or text (free input). Returns {answers:[{id,selectedValues,freeText}]}. Blocks until the user answers in the product UI.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique id for this question" },
                question: { type: "string", description: "The question text" },
                kind: { type: "string", enum: ["select", "text"] },
                options: {
                  type: "array",
                  description: "Required when kind=select",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "Option text shown to the user" },
                      value: {
                        type: "string",
                        description: "Returned in selectedValues; defaults to label",
                      },
                      description: { type: "string" },
                    },
                    required: ["label"],
                  },
                },
                allowOther: {
                  type: "boolean",
                  description: "Offer an extra free-text row of the user's own",
                },
              },
              required: ["id", "question"],
            },
          },
        },
        required: ["questions"],
      },
      entrypoint,
    },
  ];
}
