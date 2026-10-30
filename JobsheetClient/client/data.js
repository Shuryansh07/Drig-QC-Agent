// Shared by the job list (index.html) and the job detail page (job.html).

// Where "Open chatbot" goes: the DRIG chatbot (the FrontEnd Slate app). Set this to its deployed URL.
const CHATBOT_URL = "http://localhost:5173/";

// Dummy jobsheet: replace with real jobs once there is an API for them.
const JOBS = [
  {
    id: "JS-1041",
    job: "Dash cam install",
    car: "2022 Ford Transit 250",
    plate: "KY 4TR-2291",
    vin: "1FTBR1C82NKA10421",
    equipment: "ZenCAM LITE",
    customer: "Bluegrass Courier Co.",
    contact: "Fleet desk · (502) 555-0141",
    scheduled: "Today, 9:00 AM",
    duration: "1.5 hours",
    address: { line1: "1450 Commerce Pkwy", line2: "Bay 3", city: "Louisville", state: "KY", zip: "40299" },
    notes: "Forward-facing camera behind the mirror. Power from the fuse box, ignition-switched.",
  },
  {
    id: "JS-1042",
    job: "GPS tracker install",
    car: "2018 Chevrolet Equinox",
    plate: "KY 7GB-4410",
    vin: "2GNAXSEV4J6104422",
    equipment: "PAT AT600",
    customer: "Derby City Rentals",
    contact: "Mark (lot manager) · (502) 555-0187",
    scheduled: "Today, 10:30 AM",
    duration: "1 hour",
    address: { line1: "3820 Bardstown Rd", line2: "Rear lot", city: "Louisville", state: "KY", zip: "40218" },
    notes: "Keyed ignition. Confirm the ignition wire before tapping; call QC if unsure.",
  },
  {
    id: "JS-1043",
    job: "SIM & SD card swap",
    car: "2021 Ram ProMaster 1500",
    plate: "IN 312-KTV",
    vin: "3C6LRVAG1ME104433",
    equipment: "AD Plus2.0",
    customer: "Ohio Valley Plumbing",
    contact: "Dispatch · (812) 555-0122",
    scheduled: "Today, 12:00 PM",
    duration: "30 minutes",
    address: { line1: "915 Spring St", line2: "", city: "Jeffersonville", state: "IN", zip: "47130" },
    notes: "Replace the SIM and the Micro SD card; the unit stays mounted.",
  },
  {
    id: "JS-1044",
    job: "Remote starter install",
    car: "2019 Toyota Camry",
    plate: "KY 2HC-7783",
    vin: "4T1B11HK5KU104444",
    equipment: "5550A-VM",
    customer: "Private customer",
    contact: "Customer · (859) 555-0163",
    scheduled: "Today, 1:30 PM",
    duration: "2.5 hours",
    address: { line1: "220 E Main St", line2: "Parking garage, level 2", city: "Lexington", state: "KY", zip: "40507" },
    notes: "Push-to-start. Customer wants the remote paired with both key fobs.",
  },
  {
    id: "JS-1045",
    job: "Ignition wiring check",
    car: "2020 Honda CR-V",
    plate: "KY 9PL-1206",
    vin: "7FARW2H51LE104455",
    equipment: "PAT AT600",
    customer: "Derby City Rentals",
    contact: "Mark (lot manager) · (502) 555-0187",
    scheduled: "Today, 3:00 PM",
    duration: "45 minutes",
    address: { line1: "3820 Bardstown Rd", line2: "Rear lot", city: "Louisville", state: "KY", zip: "40218" },
    notes: "Tracker reports ignition on while parked. Check the ignition tap.",
  },
  {
    id: "JS-1046",
    job: "Dual dash cam install",
    car: "2023 Chevrolet Silverado 1500",
    plate: "KY 5RX-3390",
    vin: "1GCUDDED8PZ104466",
    equipment: "AD Plus2.0",
    customer: "Bluegrass Courier Co.",
    contact: "Fleet desk · (502) 555-0141",
    scheduled: "Tomorrow, 8:30 AM",
    duration: "2 hours",
    address: { line1: "1450 Commerce Pkwy", line2: "Bay 1", city: "Louisville", state: "KY", zip: "40299" },
    notes: "Front and cabin camera. Route the cabin camera cable along the headliner.",
  },
  {
    id: "JS-1047",
    job: "Tracker relocation",
    car: "2017 Nissan Altima",
    plate: "KY 1MN-5528",
    vin: "1N4AL3AP0HC104477",
    equipment: "Wahoo",
    customer: "Private customer",
    contact: "Customer · (502) 555-0109",
    scheduled: "Tomorrow, 11:00 AM",
    duration: "1 hour",
    address: { line1: "7105 Preston Hwy", line2: "", city: "Louisville", state: "KY", zip: "40219" },
    notes: "Move the tracker from under the dash to behind the glovebox.",
  },
  {
    id: "JS-1048",
    job: "Camera re-aim",
    car: "2022 Ford F-150",
    plate: "IN 448-PWD",
    vin: "1FTFW1E83NF104488",
    equipment: "ZenCAM LITE",
    customer: "Ohio Valley Plumbing",
    contact: "Dispatch · (812) 555-0122",
    scheduled: "Tomorrow, 2:00 PM",
    duration: "30 minutes",
    address: { line1: "915 Spring St", line2: "", city: "Jeffersonville", state: "IN", zip: "47130" },
    notes: "Footage points too low. Re-aim so the horizon sits in the top third.",
  },
];

const STORAGE_KEY = "drig.jobsheet.done";

// Ticks are kept in this browser only; storage can be blocked (private window), so every access is guarded.
const loadDone = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

const saveDone = (done) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...done]));
  } catch {
    // Not remembered across reloads; the page still works.
  }
};

const jobUrl = (job) => `job.html?id=${encodeURIComponent(job.id)}`;

/** The chatbot, told which job it is for: it narrows the manuals to the equipment and knows the car. */
const chatbotUrlFor = (job) => {
  const url = new URL(CHATBOT_URL);
  url.searchParams.set("job", job.id);
  url.searchParams.set("car", job.car);
  url.searchParams.set("equipment", job.equipment);
  return url.toString();
};

/** "1450 Commerce Pkwy, Bay 3, Louisville, KY 40299" */
const formatAddress = (a) => [a.line1, a.line2, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(", ");

/** A done/pending checkbox. onChange gets the new state after it is saved. */
const doneToggle = (job, done, onChange) => {
  const toggle = document.createElement("label");
  toggle.className = "done-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = done.has(job.id);
  input.setAttribute("aria-label", `Mark ${job.job} (${job.id}) as done`);
  const box = document.createElement("span");
  box.className = "box";
  const label = document.createElement("span");
  label.className = "done-label";
  label.textContent = input.checked ? "Done" : "Pending";
  toggle.append(input, box, label);

  input.addEventListener("change", () => {
    if (input.checked) done.add(job.id);
    else done.delete(job.id);
    saveDone(done);
    label.textContent = input.checked ? "Done" : "Pending";
    onChange(input.checked);
  });
  return toggle;
};
