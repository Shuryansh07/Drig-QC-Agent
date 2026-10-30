// The job list. Jobs, the done ticks and the toggle come from data.js.

const done = loadDone();
const tbody = document.getElementById("jobs");

const cell = (label, className, content) => {
  const td = document.createElement("td");
  td.dataset.label = label;
  if (className) td.className = className;
  if (typeof content === "string") {
    // In a span, so a finished job strikes through the value and not the phone layout's label.
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = content;
    td.append(value);
  } else {
    td.append(...content);
  }
  return td;
};

const renderProgress = () => {
  const count = JOBS.filter((j) => done.has(j.id)).length;
  document.getElementById("progress").textContent = `${count} of ${JOBS.length} jobs done`;
  document.getElementById("progress-bar").style.width = `${(count / JOBS.length) * 100}%`;
};

for (const job of JOBS) {
  const row = document.createElement("tr");
  row.className = "job-row";
  row.classList.toggle("is-done", done.has(job.id));

  // The job name is the real link (keyboard, middle-click, screen readers); the rest of the row follows it.
  const link = document.createElement("a");
  link.className = "job-name";
  link.href = jobUrl(job);
  link.textContent = job.job;
  const id = document.createElement("span");
  id.className = "job-id";
  id.textContent = job.id;
  link.append(id);

  const toggle = doneToggle(job, done, (checked) => {
    row.classList.toggle("is-done", checked);
    renderProgress();
  });

  row.addEventListener("click", (event) => {
    // Ticking "done" stays on the list; a click on the link is already handled by the link.
    if (event.target.closest(".done-toggle, a")) return;
    window.location.href = link.href;
  });

  row.append(
    cell("Job name", null, [link]),
    cell("Car name", "cell-car", job.car),
    cell("Equipment name", "cell-equipment", job.equipment),
    cell("Mark as done", "col-done", [toggle]),
  );
  tbody.append(row);
}

renderProgress();
