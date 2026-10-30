// One job, picked by ?id= (job.html?id=JS-1041). Jobs, the done ticks and the toggle come from data.js.

const id = new URLSearchParams(window.location.search).get("id");
const job = JOBS.find((j) => j.id === id);

// With a job, the chatbot opens knowing its car and equipment; without one (bad ?id=) it opens plain.
for (const link of document.querySelectorAll("#chatbot-link, #chatbot-link-help")) link.href = job ? chatbotUrlFor(job) : CHATBOT_URL;

const setText = (elementId, text) => {
  document.getElementById(elementId).textContent = text || "—";
};

if (!job) {
  document.getElementById("not-found").hidden = false;
} else {
  document.title = `${job.job} · ${job.id} · DRIG Jobsheet`;
  const article = document.getElementById("job");
  const done = loadDone();
  article.classList.toggle("is-done", done.has(job.id));

  setText("job-id", job.id);
  setText("job-name", job.job);
  setText("job-car", job.car);
  setText("job-plate", job.plate);
  setText("job-vin", job.vin);
  setText("job-equipment", job.equipment);
  setText("job-scheduled", job.scheduled);
  setText("job-duration", job.duration);
  setText("job-customer", job.customer);
  setText("job-contact", job.contact);
  setText("job-notes", job.notes);
  setText("help-equipment", job.equipment);
  setText("help-car", job.car);

  // One line per part of the address, as it would be written on an envelope.
  const address = document.getElementById("job-address");
  const a = job.address;
  for (const line of [a.line1, a.line2, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean)) {
    const span = document.createElement("span");
    span.textContent = line;
    address.append(span);
  }

  const full = formatAddress(a);
  document.getElementById("map-link").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`;

  const copy = document.getElementById("copy-address");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(full);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Couldn't copy";
    }
    setTimeout(() => (copy.textContent = "Copy address"), 2000);
  });

  document.getElementById("done-slot").append(doneToggle(job, done, (checked) => article.classList.toggle("is-done", checked)));
  article.hidden = false;
}
