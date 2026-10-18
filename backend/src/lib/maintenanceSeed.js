// Round 215 — the starting PM schedules for the fleet the owner listed on
// 18 Oct 2026 (claude/maintenance-pm-schedules-seed.json in the project).
// Loaded ONCE by round215Schema.js; after that the schedules live in the
// database and the Administrator edits or deletes them on the PM schedules
// screen — editing this file later changes nothing on a live installation.
//
// basis: OEM = manufacturer published · ENGINE = engine maker guidance ·
// PRACTICE = industry practice, to be confirmed against the service book.
// trigger.type: day | week | month | km | hours | m3 | once_km.
// Due = whichever of every / or_months / or_days / or_hours comes first.

export const SEED_SOURCES = {
  "S1": {
    "title": "Honda Shine 100 — official page (service schedule, oil grade, warranty)",
    "url": "https://www.honda2wheelersindia.com/motorcycle/shine-100"
  },
  "S2": {
    "title": "JCB 3DX — official page (fuel filter 1000 h, hydraulic oil 4000 h on current model)",
    "url": "https://www.jcb.com/en-in/products/backhoe-loaders/jcb-3dx"
  },
  "S3": {
    "title": "JCB backhoe maintenance schedule 500/1000/2000 h (HVI)",
    "url": "https://heavyvehicleinspection.com/blog/post/jcb-maintenance-schedule"
  },
  "S4": {
    "title": "Schwing Stetter — hydraulic oils (change based on oil analysis)",
    "url": "https://schwing-stetter.com/de_en/service/spare-parts-accessories/hydraulic-oils.html"
  },
  "S5": {
    "title": "Concrete mixer truck maintenance — drum, drive & hydraulics (FleetRabbit)",
    "url": "https://fleetrabbit.com/blogs/post/concrete-mixer-truck-maintenance-guide"
  },
  "S6": {
    "title": "Concrete pump maintenance schedule (FieldFix)",
    "url": "https://www.fieldfix.ai/maintenance/concrete-pump"
  },
  "S7": {
    "title": "Concrete batching plant maintenance schedule (HZS)",
    "url": "https://hzsmove.com/blog/posts/concrete-plant-maintenance-schedule-guide"
  },
  "S8": {
    "title": "Cummins 6.7 maintenance schedule (oil 500 h)",
    "url": "https://www.dieselhub.com/maintenance/6.7-cummins-maintenance-schedule.html"
  },
  "S9": {
    "title": "Truck engine oil change intervals India — Cummins severe duty, CK-4 for DPF",
    "url": "https://trucks-india.com/blog/truck-engine-oil-guide"
  },
  "S10": {
    "title": "Tata LPT 712 — official page (4SPCR BS6 engine, warranty 3 yr / 3 lakh km)",
    "url": "https://trucks.tatamotors.com/lpt/tata-lpt-712"
  },
  "S11": {
    "title": "Tata small trucks — BS6 care tips (brakes every 6 months)",
    "url": "https://smalltrucks.tatamotors.com/blogs/tips-effective-care-your-bs6-small-commercial-trucks"
  },
  "S12": {
    "title": "TVS Jupiter service schedule (BikeFix)",
    "url": "https://www.bikefixpune.in/blog/tvs-jupiter-service-cost-pune"
  },
  "S13": {
    "title": "Honda Shine service schedule (BikeFix)",
    "url": "https://www.bikefixpune.in/blog/honda-shine-service-cost-pune"
  }
};

export const SEED_ASSETS = [
  {
    "key": "TM-SIGNA",
    "name": "Transit Mixer — Tata Signa 2825.K",
    "detail": "EBSIV · 8 REPTO · 2022 · Cummins ISBe · Schwing Stetter drum",
    "group": "Transit mixer"
  },
  {
    "key": "TM-AL2820",
    "name": "Transit Mixer — Ashok Leyland CE2820/39 R RMC",
    "detail": "2023 · H-series 6-cyl · Schwing Stetter drum",
    "group": "Transit mixer"
  },
  {
    "key": "TM-PRIMA",
    "name": "Transit Mixer — Tata Prima 2830.K",
    "detail": "BSIV · 45W · 9 REPTO · 2024 · Cummins ISBe 6.7 · Schwing Stetter drum",
    "group": "Transit mixer"
  },
  {
    "key": "PU-712",
    "name": "Pick Up Truck — Tata 712 SFC",
    "detail": "DCR38HSD 125B6M5 · 2024 · 4SPCR BS6",
    "group": "Light truck"
  },
  {
    "key": "BP-2518",
    "name": "Boom Placer — Ashok Leyland 2518 ilH3/3C + Schwing Stetter 36 m pump",
    "detail": "2015",
    "group": "Boom pump"
  },
  {
    "key": "LD-3DX",
    "name": "Loader — JCB 3DX 2WD Side Shift Backhoe",
    "detail": "2017",
    "group": "Loader"
  },
  {
    "key": "PU-BOLERO",
    "name": "Pickup — Mahindra Bolero Camper Gold ZX 2WD",
    "detail": "2023 · m2DiCR 2.5",
    "group": "Light vehicle"
  },
  {
    "key": "PLANT-H1J",
    "name": "Batching Plant — Schwing Stetter H1J 60 m³/h",
    "detail": "1 m³ twin shaft mixer · 2022",
    "group": "Plant"
  },
  {
    "key": "MC-SHINE",
    "name": "Motorcycle — Honda Shine 100",
    "detail": "2024",
    "group": "Two-wheeler"
  },
  {
    "key": "SC-JUPITER",
    "name": "Scooter — TVS Jupiter",
    "detail": "2024",
    "group": "Two-wheeler"
  }
];

export const SEED_SCHEDULES = [
 {
  "asset": [
   "TM-SIGNA",
   "TM-AL2820",
   "TM-PRIMA"
  ],
  "name": "Daily driver check",
  "trigger": {
   "type": "day",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S5"
  ],
  "checklist": [
   "Engine oil level",
   "Coolant level",
   "Air filter restriction indicator",
   "AdBlue / DEF level (if SCR fitted)",
   "Tyres, wheel nuts, leaks walk-round",
   "Drum water tank full, water pump working",
   "Drum washed out after last load"
  ],
  "tasks": []
 },
 {
  "asset": [
   "TM-SIGNA",
   "TM-AL2820",
   "TM-PRIMA"
  ],
  "name": "Weekly inspection & greasing",
  "trigger": {
   "type": "week",
   "every": 1,
   "day": "Sat"
  },
  "basis": "PRACTICE",
  "sources": [
   "S5"
  ],
  "checklist": [
   "Existing 36-item weekly transit mixer inspection checklist",
   "Drum drive hub / gearbox — oil leaks",
   "Drum rollers and drum track condition",
   "Hydraulic hoses — wear, leaks",
   "Drum fins/flights — visual wear",
   "Battery terminals, belt tension"
  ],
  "tasks": [
   {
    "task": "Grease chassis points — propeller shaft, spring pins, king pins",
    "parts": "Grease MP3"
   },
   {
    "task": "Grease drum rollers and drum ring",
    "parts": "Grease MP3"
   },
   {
    "task": "Clean water pump strainer",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "TM-SIGNA",
   "TM-PRIMA"
  ],
  "name": "Engine service — oil, filters (Cummins)",
  "trigger": {
   "type": "km",
   "every": 15000,
   "or_hours": 500,
   "or_months": 6
  },
  "basis": "ENGINE",
  "sources": [
   "S8",
   "S9"
  ],
  "note": "Cummins severe-duty interval (mixers idle and run PTO). Tata booklet may allow longer — Admin can edit.",
  "checklist": [
   "Oil condition before drain",
   "Leaks — sump, filter housing, turbo lines",
   "Air filter element condition",
   "Belt and tensioner"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "15W-40 CI-4+/CK-4 — as per Cummins spec"
   },
   {
    "task": "Replace engine oil filter",
    "parts": "Oil filter"
   },
   {
    "task": "Replace primary and secondary fuel filters / drain water separator",
    "parts": "Fuel filters"
   },
   {
    "task": "Clean air filter primary element",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "TM-AL2820"
  ],
  "name": "Engine service — oil, filters (Ashok Leyland H-series)",
  "trigger": {
   "type": "km",
   "every": 15000,
   "or_hours": 500,
   "or_months": 6
  },
  "basis": "PRACTICE",
  "sources": [
   "S9"
  ],
  "note": "Set to the same severe-duty interval as the Tata mixers. Confirm against the Ashok Leyland service booklet.",
  "checklist": [
   "Oil condition before drain",
   "Leaks — sump, filter housing",
   "Air filter element condition",
   "Belt and tensioner"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "15W-40 — Ashok Leyland approved"
   },
   {
    "task": "Replace engine oil filter",
    "parts": "Oil filter"
   },
   {
    "task": "Replace fuel filters / drain water separator",
    "parts": "Fuel filters"
   },
   {
    "task": "Clean air filter primary element",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "TM-SIGNA",
   "TM-AL2820",
   "TM-PRIMA"
  ],
  "name": "Chassis major service",
  "trigger": {
   "type": "km",
   "every": 60000,
   "or_months": 12
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Clutch free play / wear",
   "Brake lining thickness and air leaks",
   "Steering linkage play",
   "Suspension — springs, U-bolts, torque rods",
   "Gearbox and axle oil levels"
  ],
  "tasks": [
   {
    "task": "Replace air filter primary element (safety element every 2nd change)",
    "parts": "Air filter"
   },
   {
    "task": "Replace air dryer cartridge",
    "parts": "Air dryer cartridge"
   },
   {
    "task": "Replace AdBlue / DEF filter (SCR trucks)",
    "parts": "DEF filter"
   }
  ]
 },
 {
  "asset": [
   "TM-SIGNA",
   "TM-AL2820",
   "TM-PRIMA"
  ],
  "name": "Gearbox, axle oil & coolant",
  "trigger": {
   "type": "km",
   "every": 120000,
   "or_months": 24
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Magnetic drain plug — metal particles",
   "Coolant condition"
  ],
  "tasks": [
   {
    "task": "Change gearbox oil",
    "parts": "Gear oil as per OEM"
   },
   {
    "task": "Change front & rear tandem axle oil",
    "parts": "85W-140 / OEM spec"
   },
   {
    "task": "Replace coolant",
    "parts": "Long-life coolant"
   }
  ]
 },
 {
  "asset": [
   "TM-SIGNA",
   "TM-AL2820",
   "TM-PRIMA"
  ],
  "name": "Drum drive — hydraulics & gearbox",
  "trigger": {
   "type": "hours",
   "every": 1000,
   "or_months": 12
  },
  "basis": "PRACTICE",
  "sources": [
   "S4",
   "S5"
  ],
  "note": "Schwing Stetter: hydraulic oil change is decided by oil analysis. First drum gearbox oil change at 500 h on new drums.",
  "checklist": [
   "Hydraulic pump temperature under load",
   "Oil cooler clean",
   "Drum gearbox / drive hub leaks"
  ],
  "tasks": [
   {
    "task": "Replace hydraulic return filter",
    "parts": "Hydraulic filter"
   },
   {
    "task": "Take hydraulic oil sample for analysis — change oil if analysis says so",
    "parts": "Hydraulic oil ISO VG 46 (if changing)"
   },
   {
    "task": "Change drum gearbox oil",
    "parts": "Gear oil as per gearbox plate"
   }
  ]
 },
 {
  "asset": [
   "TM-SIGNA",
   "TM-AL2820",
   "TM-PRIMA"
  ],
  "name": "Drum wear measurement",
  "trigger": {
   "type": "m3",
   "every": 10000,
   "or_months": 6
  },
  "basis": "PRACTICE",
  "sources": [
   "S5"
  ],
  "checklist": [
   "Drum shell thickness (gauge points)",
   "Flight/fin height and wear",
   "Charging hopper and chute wear"
  ],
  "tasks": [
   {
    "task": "Record drum shell and flight measurements",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PU-712"
  ],
  "name": "Daily driver check",
  "trigger": {
   "type": "day",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Engine oil, coolant levels",
   "AdBlue / DEF level",
   "DPF / engine warning lamps",
   "Tyres and leaks walk-round"
  ],
  "tasks": []
 },
 {
  "asset": [
   "PU-712"
  ],
  "name": "Engine service — oil, filters",
  "trigger": {
   "type": "km",
   "every": 20000,
   "or_months": 12
  },
  "basis": "PRACTICE",
  "sources": [
   "S9",
   "S10"
  ],
  "note": "BS6 engine with DPF: use low-ash CK-4 class oil. Free services as per Tata booklet within warranty (3 yr / 3 lakh km).",
  "checklist": [
   "Oil condition",
   "Leaks",
   "DPF soot / regeneration history (scan)"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "CK-4 low-ash oil — Tata spec"
   },
   {
    "task": "Replace oil filter",
    "parts": "Oil filter"
   },
   {
    "task": "Replace fuel filter",
    "parts": "Fuel filter"
   },
   {
    "task": "Clean air filter",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PU-712"
  ],
  "name": "Brakes check",
  "trigger": {
   "type": "month",
   "every": 6
  },
  "basis": "OEM",
  "sources": [
   "S11"
  ],
  "checklist": [
   "Brake lining / pad thickness",
   "Brake fluid / air leaks",
   "Hand brake"
  ],
  "tasks": []
 },
 {
  "asset": [
   "PU-712"
  ],
  "name": "Major service — gearbox, axle, coolant",
  "trigger": {
   "type": "km",
   "every": 60000,
   "or_months": 24
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Clutch",
   "Suspension",
   "Steering play"
  ],
  "tasks": [
   {
    "task": "Change gearbox oil",
    "parts": "Gear oil"
   },
   {
    "task": "Change rear axle oil",
    "parts": "Axle oil"
   },
   {
    "task": "Replace air filter",
    "parts": "Air filter"
   },
   {
    "task": "Replace coolant",
    "parts": "Coolant"
   }
  ]
 },
 {
  "asset": [
   "BP-2518"
  ],
  "name": "Daily pump & boom check",
  "trigger": {
   "type": "day",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S6"
  ],
  "checklist": [
   "Hydraulic oil level",
   "Water box — full, no concrete or oil in water",
   "Outriggers extend & lock",
   "Boom full movement, hoses, no leaks",
   "Delivery line clamps and seals",
   "Emergency stop works",
   "Engine oil & coolant"
  ],
  "tasks": [
   {
    "task": "Grease pump and boom grease points",
    "parts": "Grease"
   },
   {
    "task": "Wash out hopper, S-tube and line after pour",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "BP-2518"
  ],
  "name": "Weekly wear check",
  "trigger": {
   "type": "week",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S6"
  ],
  "checklist": [
   "Wear plate & cutting ring gap",
   "S-tube / rock valve condition",
   "Agitator and hopper seals",
   "Delivery pipe & elbow visual wear"
  ],
  "tasks": []
 },
 {
  "asset": [
   "BP-2518"
  ],
  "name": "Delivery pipe thickness",
  "trigger": {
   "type": "m3",
   "every": 10000,
   "or_months": 3
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Pipe wall thickness at marked points (ultrasonic gauge)",
   "Elbows and reducers",
   "Boom pipe clamps"
  ],
  "tasks": [
   {
    "task": "Rotate straight pipes 120° if wear uneven",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "BP-2518"
  ],
  "name": "Pump service",
  "trigger": {
   "type": "hours",
   "every": 500,
   "or_months": 6
  },
  "basis": "PRACTICE",
  "sources": [
   "S6"
  ],
  "checklist": [
   "Concrete pistons and cylinders wear",
   "Hydraulic hoses"
  ],
  "tasks": [
   {
    "task": "Replace hydraulic filters",
    "parts": "Hydraulic filters"
   },
   {
    "task": "Change chassis engine oil and filter (engine hours count while pumping)",
    "parts": "15W-40, oil filter"
   },
   {
    "task": "Replace fuel filters",
    "parts": "Fuel filters"
   }
  ]
 },
 {
  "asset": [
   "BP-2518"
  ],
  "name": "Annual — hydraulic oil analysis & boom structure",
  "trigger": {
   "type": "hours",
   "every": 1000,
   "or_months": 12
  },
  "basis": "OEM",
  "sources": [
   "S4",
   "S6"
  ],
  "note": "Schwing Stetter: change hydraulic oil based on oil analysis.",
  "checklist": [
   "Boom sections, pins & welds — cracks, bends, corrosion",
   "Outrigger structure",
   "Turret / slew ring bolts"
  ],
  "tasks": [
   {
    "task": "Take hydraulic oil sample — change oil and clean tank if analysis says so",
    "parts": "Hydraulic oil ISO VG 46"
   }
  ]
 },
 {
  "asset": [
   "BP-2518"
  ],
  "name": "Chassis service (Ashok Leyland 2518)",
  "trigger": {
   "type": "km",
   "every": 20000,
   "or_months": 12
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Brakes",
   "Clutch",
   "Suspension",
   "Gearbox & axle oil levels"
  ],
  "tasks": [
   {
    "task": "Grease chassis points",
    "parts": "Grease"
   },
   {
    "task": "Change gearbox and axle oil every 2nd service",
    "parts": "Gear oil, axle oil"
   }
  ]
 },
 {
  "asset": [
   "LD-3DX"
  ],
  "name": "Daily 10-hour check",
  "trigger": {
   "type": "day",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S3"
  ],
  "checklist": [
   "Engine oil level",
   "Hydraulic tank sight gauge",
   "Coolant level",
   "Leaks — engine, axle, kingpost, cylinders",
   "Tyres",
   "Bucket teeth and safety items"
  ],
  "tasks": []
 },
 {
  "asset": [
   "LD-3DX"
  ],
  "name": "Weekly greasing",
  "trigger": {
   "type": "hours",
   "every": 50,
   "or_days": 7
  },
  "basis": "PRACTICE",
  "sources": [
   "S3"
  ],
  "checklist": [
   "Belt tension",
   "Battery"
  ],
  "tasks": [
   {
    "task": "Grease all pivot pins — kingpost, boom, dipper, loader arms, stabilisers",
    "parts": "Grease"
   }
  ]
 },
 {
  "asset": [
   "LD-3DX"
  ],
  "name": "500-hour service",
  "trigger": {
   "type": "hours",
   "every": 500,
   "or_months": 6
  },
  "basis": "PRACTICE",
  "sources": [
   "S3"
  ],
  "checklist": [
   "Kingpost pin wear",
   "Loader arm strut, boom lock, stabiliser pins",
   "Belts and tyres"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "15W-40 JCB spec"
   },
   {
    "task": "Replace engine oil filter",
    "parts": "Oil filter"
   },
   {
    "task": "Replace fuel filters",
    "parts": "Fuel filters"
   },
   {
    "task": "Replace hydraulic return filter",
    "parts": "Hydraulic filter"
   },
   {
    "task": "Clean / replace air filter outer element",
    "parts": "Air filter"
   }
  ]
 },
 {
  "asset": [
   "LD-3DX"
  ],
  "name": "1000-hour service",
  "trigger": {
   "type": "hours",
   "every": 1000,
   "or_months": 12
  },
  "basis": "PRACTICE",
  "sources": [
   "S3"
  ],
  "checklist": [
   "Turbo and charge cooler",
   "Alternator and starter"
  ],
  "tasks": [
   {
    "task": "Change transmission oil and filter",
    "parts": "Transmission oil, filter"
   },
   {
    "task": "Change rear axle oil (2WD)",
    "parts": "Axle oil"
   },
   {
    "task": "Replace coolant",
    "parts": "JCB coolant"
   }
  ]
 },
 {
  "asset": [
   "LD-3DX"
  ],
  "name": "2000-hour service",
  "trigger": {
   "type": "hours",
   "every": 2000,
   "or_months": 24
  },
  "basis": "PRACTICE",
  "sources": [
   "S2",
   "S3"
  ],
  "note": "Current JCB 3DX models state a 4000 h hydraulic oil interval; set to 2000 h for this 2017 machine — check its operator handbook.",
  "checklist": [
   "Brakes",
   "Structure — cracks or unauthorised welds",
   "Electrical harness"
  ],
  "tasks": [
   {
    "task": "Change hydraulic oil",
    "parts": "Hydraulic oil (approx. 110–130 L)"
   }
  ]
 },
 {
  "asset": [
   "PU-BOLERO"
  ],
  "name": "Periodic service",
  "trigger": {
   "type": "km",
   "every": 10000,
   "or_months": 12
  },
  "basis": "PRACTICE",
  "sources": [],
  "note": "Confirm interval against the Bolero Camper owner's manual / Mahindra service booklet.",
  "checklist": [
   "Brakes",
   "Tyres and rotation",
   "Suspension and steering",
   "Leaks"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "Mahindra-approved diesel oil"
   },
   {
    "task": "Replace oil filter",
    "parts": "Oil filter"
   },
   {
    "task": "Clean air filter",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PU-BOLERO"
  ],
  "name": "Major service",
  "trigger": {
   "type": "km",
   "every": 40000,
   "or_months": 24
  },
  "basis": "PRACTICE",
  "sources": [],
  "checklist": [
   "Clutch",
   "Gearbox and axle oil levels"
  ],
  "tasks": [
   {
    "task": "Replace fuel filter",
    "parts": "Fuel filter"
   },
   {
    "task": "Replace air filter",
    "parts": "Air filter"
   },
   {
    "task": "Replace coolant",
    "parts": "Coolant"
   },
   {
    "task": "Replace brake fluid",
    "parts": "DOT 4"
   }
  ]
 },
 {
  "asset": [
   "PLANT-H1J"
  ],
  "name": "Daily plant check",
  "trigger": {
   "type": "day",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S7"
  ],
  "checklist": [
   "Mixer arms, blades, liners — breakage",
   "Shaft seal grease / lubrication pump level",
   "Conveyor belt — tears, tracking",
   "Air compressor oil, drain moisture traps",
   "Load cells — zero check",
   "Silo aeration and filters clear",
   "Water meter / flow sensor"
  ],
  "tasks": [
   {
    "task": "Wash out mixer and discharge gate after last batch",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PLANT-H1J"
  ],
  "name": "Weekly plant service",
  "trigger": {
   "type": "week",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S7"
  ],
  "checklist": [
   "Blade-to-liner gap — adjust if over 5 mm",
   "Mixer, conveyor & screw gearbox oil levels",
   "Skip rope / conveyor scrapers (as fitted)"
  ],
  "tasks": [
   {
    "task": "Lubricate mixer shaft end seals",
    "parts": "Grease"
   },
   {
    "task": "Drain air receiver tank, clean compressor air filter",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PLANT-H1J"
  ],
  "name": "Monthly calibration & checks",
  "trigger": {
   "type": "month",
   "every": 1
  },
  "basis": "PRACTICE",
  "sources": [
   "S7"
  ],
  "checklist": [
   "Belt tracking — realign if over 20 mm drift",
   "Cement screw hanger bearings and couplings",
   "Silo blower and filter"
  ],
  "tasks": [
   {
    "task": "Verify load cell calibration with test weights",
    "parts": ""
   },
   {
    "task": "Check / recalibrate water meter",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PLANT-H1J"
  ],
  "name": "Quarterly wear & filters",
  "trigger": {
   "type": "month",
   "every": 3
  },
  "basis": "PRACTICE",
  "sources": [
   "S7"
  ],
  "checklist": [
   "Liner and blade thickness — replace below 60% remaining",
   "Pneumatic leak-down test (15 min)"
  ],
  "tasks": [
   {
    "task": "Replace silo filter bags",
    "parts": "Filter bags"
   },
   {
    "task": "Gearbox oil sample",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "PLANT-H1J"
  ],
  "name": "Annual plant overhaul",
  "trigger": {
   "type": "month",
   "every": 12
  },
  "basis": "PRACTICE",
  "sources": [
   "S7"
  ],
  "checklist": [
   "Conveyor belt — replace if over 30% worn",
   "Pneumatic cylinders seals"
  ],
  "tasks": [
   {
    "task": "Overhaul / replace mixer shaft seals",
    "parts": "Seal kit"
   },
   {
    "task": "Change mixer gearbox oil",
    "parts": "Gear oil as per gearbox plate"
   },
   {
    "task": "Replace compressor oil, filters and belts",
    "parts": "Compressor kit"
   }
  ]
 },
 {
  "asset": [
   "MC-SHINE"
  ],
  "name": "1st free service",
  "trigger": {
   "type": "once_km",
   "at": 1000,
   "or_days": 30
  },
  "basis": "OEM",
  "sources": [
   "S1"
  ],
  "checklist": [
   "Chain slack",
   "Brakes",
   "Lights"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA"
   }
  ]
 },
 {
  "asset": [
   "MC-SHINE"
  ],
  "name": "2nd free service",
  "trigger": {
   "type": "once_km",
   "at": 6000,
   "or_days": 180
  },
  "basis": "OEM",
  "sources": [
   "S1"
  ],
  "checklist": [
   "Chain slack",
   "Brakes"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA"
   }
  ]
 },
 {
  "asset": [
   "MC-SHINE"
  ],
  "name": "3rd free service",
  "trigger": {
   "type": "once_km",
   "at": 12000,
   "or_days": 365
  },
  "basis": "OEM",
  "sources": [
   "S1"
  ],
  "checklist": [
   "Chain slack",
   "Brakes",
   "Spark plug"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA"
   },
   {
    "task": "Replace air filter",
    "parts": "Air filter"
   }
  ]
 },
 {
  "asset": [
   "MC-SHINE"
  ],
  "name": "Paid periodic service",
  "trigger": {
   "type": "km",
   "every": 6000,
   "or_months": 6
  },
  "basis": "OEM",
  "sources": [
   "S1",
   "S13"
  ],
  "checklist": [
   "Chain and sprocket",
   "Brakes",
   "Spark plug every 12,000 km"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA, 1.1 L"
   },
   {
    "task": "Replace air filter every 12,000 km",
    "parts": "Air filter"
   }
  ]
 },
 {
  "asset": [
   "MC-SHINE"
  ],
  "name": "Chain clean & lube",
  "trigger": {
   "type": "km",
   "every": 1000
  },
  "basis": "PRACTICE",
  "sources": [
   "S13"
  ],
  "checklist": [
   "Chain slack 15–20 mm"
  ],
  "tasks": [
   {
    "task": "Clean and lubricate drive chain",
    "parts": "Chain lube"
   }
  ]
 },
 {
  "asset": [
   "SC-JUPITER"
  ],
  "name": "1st service",
  "trigger": {
   "type": "once_km",
   "at": 750,
   "or_days": 30
  },
  "basis": "PRACTICE",
  "sources": [
   "S12"
  ],
  "checklist": [
   "Brakes",
   "Lights"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA, 0.8 L"
   }
  ]
 },
 {
  "asset": [
   "SC-JUPITER"
  ],
  "name": "2nd service",
  "trigger": {
   "type": "once_km",
   "at": 3000,
   "or_days": 90
  },
  "basis": "PRACTICE",
  "sources": [
   "S12"
  ],
  "checklist": [
   "Brakes"
  ],
  "tasks": [
   {
    "task": "Change engine oil and gear oil, clean strainer",
    "parts": "10W-30, gear oil"
   },
   {
    "task": "Clean air filter",
    "parts": ""
   }
  ]
 },
 {
  "asset": [
   "SC-JUPITER"
  ],
  "name": "3rd service",
  "trigger": {
   "type": "once_km",
   "at": 6000,
   "or_days": 180
  },
  "basis": "PRACTICE",
  "sources": [
   "S12"
  ],
  "checklist": [
   "CVT belt",
   "Spark plug"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA"
   },
   {
    "task": "Clean / replace air filter",
    "parts": "Air filter"
   }
  ]
 },
 {
  "asset": [
   "SC-JUPITER"
  ],
  "name": "4th service",
  "trigger": {
   "type": "once_km",
   "at": 9000,
   "or_days": 365
  },
  "basis": "PRACTICE",
  "sources": [
   "S12"
  ],
  "checklist": [
   "Full CVT inspection",
   "Brakes"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA"
   }
  ]
 },
 {
  "asset": [
   "SC-JUPITER"
  ],
  "name": "Paid periodic service",
  "trigger": {
   "type": "km",
   "every": 3000,
   "or_months": 3
  },
  "basis": "PRACTICE",
  "sources": [
   "S12"
  ],
  "checklist": [
   "Brake shoes — replace below 2 mm",
   "CVT belt — replace around 20,000 km"
  ],
  "tasks": [
   {
    "task": "Change engine oil",
    "parts": "10W-30 JASO MA, 0.8 L"
   },
   {
    "task": "Spark plug every 10,000 km",
    "parts": "Spark plug"
   }
  ]
 }
];
