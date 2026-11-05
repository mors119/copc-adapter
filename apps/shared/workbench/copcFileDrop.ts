export type LocalCopcFileCandidate = Pick<File, "name" | "size" | "type">;

export type CopcFileDropOptions = {
  readonly onFile: (file: File) => void | Promise<void>;
  readonly onError: (message: string) => void;
};

const SUPPORTED_COPC_SUFFIX = /\.(?:copc\.laz|copc|laz)$/i;

/** Return a recoverable message when a local file cannot be a COPC candidate. */
export function validateLocalCopcFileCandidate(
  file: LocalCopcFileCandidate,
): string | undefined {
  if (file.size === 0) {
    return "The selected file is empty. Choose a non-empty COPC file and try again.";
  }

  const name = file.name.trim();
  if (/\.las$/i.test(name)) {
    return "Ordinary LAS files are not supported. Choose a COPC file with hierarchy metadata.";
  }

  if (
    !SUPPORTED_COPC_SUFFIX.test(name) &&
    file.type.toLowerCase() !== "application/octet-stream"
  ) {
    return "Unsupported file type. Choose a .copc.laz, .copc, or .laz file. Ordinary LAS/LAZ files without COPC hierarchy metadata are not supported.";
  }

  return undefined;
}

/** Validate and route one local File into an application's existing loader. */
export function processLocalCopcFile(
  file: File,
  options: CopcFileDropOptions,
): void {
  const error = validateLocalCopcFileCandidate(file);
  if (error) {
    options.onError(error);
    return;
  }

  try {
    void Promise.resolve(options.onFile(file)).catch(() => {
      options.onError(
        `Could not read ${file.name}. Choose the COPC file again and retry.`,
      );
    });
  } catch {
    options.onError(
      `Could not read ${file.name}. Choose the COPC file again and retry.`,
    );
  }
}

function containsFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types).includes("Files")) return true;
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

function createDropOverlay(document: Document): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.className = "copc-file-drop-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.setAttribute("aria-label", "COPC file drop target");

  const message = document.createElement("div");
  message.className = "copc-file-drop-overlay__message";
  const title = document.createElement("strong");
  title.textContent = "Drop a COPC file here";
  const detail = document.createElement("span");
  detail.textContent = "One file at a time · read locally in your browser";
  message.append(title, detail);
  overlay.append(message);
  return overlay;
}

/** Mount one page-wide, browser-local COPC drop target. */
export function mountCopcFileDropTarget(
  options: CopcFileDropOptions,
  document: Document = globalThis.document,
): { destroy(): void } {
  const overlay = createDropOverlay(document);
  document.body.append(overlay);
  let active = false;
  let leaveFrame: number | undefined;

  const cancelScheduledClear = (): void => {
    if (leaveFrame === undefined) return;
    globalThis.window.cancelAnimationFrame(leaveFrame);
    leaveFrame = undefined;
  };

  const show = (): void => {
    cancelScheduledClear();
    active = true;
    overlay.hidden = false;
    document.documentElement.classList.add("copc-file-drag-active");
  };
  const clear = (): void => {
    cancelScheduledClear();
    active = false;
    overlay.hidden = true;
    document.documentElement.classList.remove("copc-file-drag-active");
  };

  const onDragEnter = (event: DragEvent): void => {
    if (!containsFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    show();
  };
  const onDragOver = (event: DragEvent): void => {
    if (!containsFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    show();
  };
  const onDragLeave = (event: DragEvent): void => {
    if (!active || !containsFilePayload(event.dataTransfer)) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && document.documentElement.contains(nextTarget)) {
      return;
    }

    // A null relatedTarget is common for native file drags. Defer the clear
    // one frame so a nested dragenter can keep the overlay active first.
    cancelScheduledClear();
    leaveFrame = globalThis.window.requestAnimationFrame(() => {
      leaveFrame = undefined;
      clear();
    });
  };
  const onDrop = (event: DragEvent): void => {
    if (!containsFilePayload(event.dataTransfer)) {
      clear();
      return;
    }
    event.preventDefault();
    clear();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length !== 1) {
      options.onError(
        files.length === 0
          ? "No local file was available from the drop. Choose the COPC file with the file picker and try again."
          : "Drop one COPC file at a time. No files were loaded.",
      );
      return;
    }
    processLocalCopcFile(files[0]!, options);
  };
  const onDragEnd = (): void => clear();

  document.addEventListener("dragenter", onDragEnter, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("dragleave", onDragLeave, true);
  document.addEventListener("drop", onDrop, true);
  globalThis.window.addEventListener("dragend", onDragEnd);
  globalThis.window.addEventListener("blur", onDragEnd);

  return {
    destroy(): void {
      clear();
      document.removeEventListener("dragenter", onDragEnter, true);
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("dragleave", onDragLeave, true);
      document.removeEventListener("drop", onDrop, true);
      globalThis.window.removeEventListener("dragend", onDragEnd);
      globalThis.window.removeEventListener("blur", onDragEnd);
      overlay.remove();
    },
  };
}
