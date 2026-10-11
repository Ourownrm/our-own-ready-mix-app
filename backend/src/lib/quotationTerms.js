// Round 204 — the default terms of each Quotation-cum-Agreement format, taken
// from the owner's Excel "Quotation_Cum_Agreement__2026_Rev1.1.xlsx" (sheets
// Cash Customer, Pay Aftr Delivery, Credit Agreement, Credit & Qty Agreement,
// Price Only). Generated once; after that the Administrator edits the library
// in the app (quotation_term_library), and each quotation keeps its own copy.
//
// {placeholders} are filled from the quotation when it is shown or printed
// (frontend/src/lib/quotationTerms.js). A clause with kind "bank" prints the
// bank account table.
export const AGREEMENT_TYPES = [
  { key: "cash", label: "Cash / 100% advance" },
  { key: "pay_after_delivery", label: "Pay after delivery" },
  { key: "credit", label: "Credit" },
  { key: "credit_qty", label: "Credit & qty commitment" },
  { key: "price_only", label: "Price only" },
];

export const DEFAULT_TERMS = {
 "cash": {
  "parties": [
   "This quotation-cum-agreement (“Agreement”) is issued by Our Own Ready Mix (hereinafter referred to as the “Supplier”) and is accepted by the customer whose name and site details are mentioned herein (hereinafter referred to as the “Customer”)."
  ],
  "sections": [
   {
    "no": "1",
    "title": "Additional & Service Charges",
    "clauses": [
     {
      "no": "1.1",
      "text": "If ordered quantity is less than {line_pump_min_qty} cubic meter, line pump mobilization charge of ₹{line_pump_charge}/- per day will be applicable"
     },
     {
      "no": "1.2",
      "text": "Mobile pump (Boom Placer) can be provided for any quantity of concrete, a minimum pumping charge of ₹{boom_min_charge}/- will apply for orders up to {boom_min_qty} cubic meter{boom_above_text}"
     },
     {
      "no": "1.3",
      "text": "If ordered quantity per truck is less than {part_load_min_qty} cubic meter, part load charge of ₹{part_load_rate}/- will be charged on each cubic meter below {part_load_min_qty} cubic meter"
     },
     {
      "no": "1.4",
      "text": "{waterproofing_text}"
     },
     {
      "no": "1.5",
      "text": "{fiber_text}"
     },
     {
      "no": "1.6",
      "text": "The above quoted price is for the cement content mentioned by us as per our Standard Mix Design. In case of any additional cement content, an additional amount shall be charged at ₹{extra_cement_rate}/- per kilogram."
     }
    ]
   },
   {
    "no": "2",
    "title": "Payment Terms and Conditions",
    "clauses": [
     {
      "no": "2.1",
      "text": "100% advance payment for the estimated quantity shall be made before dispatch of concrete. Any additional quantity supplied shall be payable immediately on the same day of pour, before release of the vehicle"
     },
     {
      "no": "2.2",
      "text": "Mode of Payment: Payments shall be made only to the Supplier’s official bank account by Account Transfer / UPI / Cheque in favour of Our Own Ready Mix. If payment is made in cash, an official receipt must be collected at the time of payment."
     },
     {
      "no": "2.3",
      "text": "Invoice Disputes: Invoices acknowledged at site shall be treated as final. Any dispute must be reported in writing within {dispute_hours} hours of completion of pour, failing which no claim will be accepted."
     },
     {
      "no": "2.4",
      "kind": "bank",
      "text": ""
     },
     {
      "no": "2.5",
      "text": "Price Revision: The Supplier reserves the right to amend prices in the event of any change in mix design, raw material costs, transportation, diesel prices, or due to change/introduction of taxes, duties, statutory levies, or applicable rules and regulations."
     }
    ]
   },
   {
    "no": "3",
    "title": "Order Placement & Delivery",
    "clauses": [
     {
      "no": "3.1",
      "text": "The Customer shall ensure safe and clear access to the site for the Supplier’s transit mixers, pumps and also ensure that the site is fully ready for concreting, all necessary arrangements, including labour, shuttering, reinforcement, vibrators, power supply, water, and lighting, shall be made by the Customer so that concreting can be completed without interruption."
     },
     {
      "no": "3.2",
      "text": "Any permissions or approvals required from local authorities, police, residents’ associations, or other bodies for vehicle movement, parking, pumping, or concrete placement shall be obtained by the Customer at their own responsibility and cost."
     },
     {
      "no": "3.3",
      "text": "The Supplier shall not be responsible for accidents, damages, or injuries occurring inside the site, except due to proven gross negligence of the Supplier"
     },
     {
      "no": "3.4",
      "text": "Once concrete is mixed as per order, it cannot be returned or cancelled, and payment shall be due irrespective of usage."
     },
     {
      "no": "3.5",
      "text": "The quoted price not include spreading, vibration, finishing, or curing unless specifically agreed."
     },
     {
      "no": "3.6",
      "text": "Concrete orders must be submitted at least 3 (Three) Days in advance, in a duly filled and authorized concrete order form or Purchase Order. Orders are subject to plant capacity and confirmation by the Supplier."
     }
    ]
   },
   {
    "no": "4",
    "title": "Quality & Responsibility",
    "clauses": [
     {
      "no": "4.1",
      "text": "Concrete shall be supplied strictly in accordance with the approved grade and mix design specified in the Customer’s order and confirmed by the Supplier."
     },
     {
      "no": "4.2",
      "text": "Concrete shall be supplied with a standard slump of 100 ± 25 mm, unless otherwise specified in writing."
     },
     {
      "no": "4.3",
      "text": "Any modification, alteration, addition of water, re-tempering not allowed at site."
     },
     {
      "no": "4.4",
      "text": "The 28-day compressive strength of the concrete is guaranteed only when sampling and cube preparation are carried out by the Supplier technicians, and the cubes are properly cured and tested at approved laboratories in accordance with the relevant IS standards."
     },
     {
      "no": "4.5",
      "text": "The Supplier shall not be responsible for cracks arising due to improper handling, curing, structural design, or site practices."
     }
    ]
   },
   {
    "no": "5",
    "title": "Pour Instructions",
    "clauses": [
     {
      "no": "5.1",
      "text": "Ensure that the existing floor/slab is structurally adequate to safely support the weight of the Ready-Mix Concrete during placement."
     },
     {
      "no": "5.2",
      "text": "Prior to concrete placement, thoroughly wet the slab surface to achieve a Saturated Surface Dry (SSD) condition. Free-standing water shall be removed."
     },
     {
      "no": "5.3",
      "text": "Place the concrete accurately and compact it properly using mechanical vibrators to eliminate air voids and ensure uniform consolidation"
     },
     {
      "no": "5.4",
      "text": "Restrict access to the roof/slab area during concrete placement. Only essential and authorized personnel shall be permitted."
     },
     {
      "no": "5.5",
      "text": "Finish and level the concrete accurately to the specified levels and slopes as per approved drawings."
     },
     {
      "no": "5.6",
      "text": "Immediately after finishing, cover the concrete surface with suitable protective sheets (such as plastic or hessian) to prevent direct sunlight and rapid moisture loss. Wet the surface with the prescribed quantity of water."
     },
     {
      "no": "5.7",
      "text": "After a minimum of 12 hours from concrete placement, commence continuous curing by soaking the concrete with water for a period of 14 days, unless otherwise specified."
     },
     {
      "no": "5.8",
      "text": "Under no circumstances shall shuttering/formwork materials be removed or replaced before the completion of 14 days from the date of concrete placement."
     }
    ]
   },
   {
    "no": "6",
    "title": "Force Majeure & Dispute Resolution",
    "clauses": [
     {
      "no": "6.1",
      "text": "Force Majeure: The Supplier shall not be liable for delays or failure in supply due to events beyond its control, including natural calamities, strikes, breakdowns, or governmental restrictions."
     },
     {
      "no": "6.2",
      "text": "Jurisdiction: Any dispute shall be resolved by arbitration at Kasaragod, Kerala. Courts at Kasaragod shall have exclusive jurisdiction."
     }
    ]
   },
   {
    "no": "7",
    "title": "Liability",
    "clauses": [
     {
      "no": "",
      "text": "Supplier’s total liability, if any, shall be strictly limited to the invoice value of the concrete supplied giving rise to the claim. No consequential or indirect damages shall be payable."
     }
    ]
   },
   {
    "no": "8",
    "title": "Validity",
    "clauses": [
     {
      "no": "",
      "text": "This quotation shall be valid for a period of {validity_text} days from the date of issue. If the quotation is not approved, duly signed, and returned within the validity period, it shall be deemed to have expired."
     }
    ]
   },
   {
    "no": "9",
    "title": "Deemed Acceptance",
    "clauses": [
     {
      "no": "9.1",
      "text": "Placing an order, making payment, accepting delivery, or allowing concrete to be poured at site will be treated as full acceptance of this quotation and its terms, even if it is not formally signed."
     },
     {
      "no": "9.2",
      "text": "These terms will apply to all supplies. Any different conditions mentioned by the Customer in messages, notes, or purchase orders will not apply unless the Supplier agrees to them in writing"
     }
    ]
   }
  ],
  "closing": [
   "Hope this competitive proposal shall meet your requirements, feel free to contact us should you have any clarification, and expect to hear from you soon with confirmation and acceptance of the proposal",
   "By signing below, the Customer confirms acceptance of this Quotation cum Agreement along with all terms and conditions mentioned herein, which shall be legally binding."
  ]
 },
 "pay_after_delivery": {
  "parties": [
   "This Quotation-cum-Agreement (“Agreement”) is issued by Our Own Ready Mix, a business entity having its principal place of business at Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala, India, PIN-671321 and registered under the Goods and Services Tax laws with GSTIN: 32AAGFO7545J1Z2, (hereinafter referred to as the “Supplier”, which expression shall, unless repugnant to the context, include its proprietors, partners, successors, and permitted assigns).",
   "The Agreement is accepted by the customer whose name, billing address, and GST details (if applicable) are mentioned herein (hereinafter referred to as the “Customer”)."
  ],
  "sections": [
   {
    "no": "1",
    "title": "Additional & Service Charges",
    "clauses": [
     {
      "no": "1.1",
      "text": "If ordered quantity is less than {line_pump_min_qty} cubic meter, line pump mobilization charge of ₹{line_pump_charge}/- per day will be applicable"
     },
     {
      "no": "1.2",
      "text": "Mobile pump (Boom Placer) can be provided for any quantity of concrete, a minimum pumping charge of ₹{boom_min_charge}/- will apply for orders up to {boom_min_qty} cubic meter{boom_above_text}"
     },
     {
      "no": "1.3",
      "text": "If ordered quantity per truck is less than {part_load_min_qty} cubic meter, part load charge of ₹{part_load_rate}/- will be charged on each cubic meter below {part_load_min_qty} cubic meter"
     },
     {
      "no": "1.4",
      "text": "{waterproofing_text}"
     },
     {
      "no": "1.5",
      "text": "{fiber_text}"
     },
     {
      "no": "1.6",
      "text": "The above quoted price is for the cement content mentioned by us as per our Standard Mix Design. In case of any additional cement content, an additional amount shall be charged at ₹{extra_cement_rate}/- per kilogram."
     },
     {
      "no": "1.7",
      "text": "Concrete in the Transit Mixer shall be fully unloaded and the vehicle released within {waiting_free_hours_text} hours from the time of arrival at site. Any delay beyond this free period, for reasons not attributable to the Supplier, shall attract waiting / detention charges @ ₹{waiting_rate} per hour or part thereof, calculated from the expiry of the free period until the vehicle is fully unloaded and released from the site."
     }
    ]
   },
   {
    "no": "2",
    "title": "Payment Terms and Conditions",
    "clauses": [
     {
      "no": "2.1",
      "text": "Payment Terms: Full payment for the concrete supplied shall be made immediately upon completion of the pour, either on the same day or not later than the next working day, unless otherwise expressly agreed in writing by the Supplier. The Supplier reserves the right to pause batching or dispatch of subsequent loads if payment commitments are not honoured during ongoing pours."
     },
     {
      "no": "2.2",
      "text": "Security for Payment: To secure payment obligations, the Customer shall provide Post-dated Security Cheque(s) or such other security as deemed acceptable by the Supplier. Such security may be provided by the Contracting Customer and/or the billing entity. The Supplier reserves the right to present the security cheque(s) for encashment without further notice if payment is not received within the stipulated post-delivery payment period. Dishonour of any security cheque shall attract action under applicable laws, including the Negotiable Instruments Act, 1881."
     },
     {
      "no": "2.3",
      "text": "Billing Instructions & Payment Responsibility : The Customer placing the order and accepting this Quotation-cum-Agreement (“Contracting Customer”) shall remain fully and unconditionally liable for payment of all supplies made under this agreement, irrespective of whether the GST tax invoice is issued in the name of the Contracting Customer or in the name of any other entity (including sister concerns, group companies, affiliates, or nominees) as instructed by the Contracting Customer.\nAny request to issue the GST tax invoice to a third party shall be treated solely as a billing instruction and shall not constitute novation, assignment, or transfer of contractual or payment obligations. The Contracting Customer warrants that it has the legal authority to bind such third-party billing entities to the payment terms of this Agreement. In the event such authority is disputed or found invalid, the Contracting Customer shall remain solely and fully liable for all payment obligations. Where invoices are raised in the name of a third party, the Contracting Customer and the billing entity shall be jointly and severally liable for payment of the invoice value, including applicable GST, interest, detention charges, and penalties. The Supplier shall not be responsible for any denial of Input Tax Credit (ITC) to any party arising from incorrect GST details or non-compliance by the Customer or billing entity. The Contracting Customer agrees to indemnify and hold the Supplier harmless against any tax demands, ITC reversals, interest, penalties, or proceedings under CGST, SGST, IGST, or other applicable laws arising from third-party billing instructions."
     },
     {
      "no": "2.4",
      "text": "Mode of Payment: Payments shall be made by Account Transfer / UPI / Cheque, payable to Our Own Ready Mix.\nAll payments shall be made strictly to the Suppliers official bank account. In case of cash payment, an official cash receipt must be collected at the time of payment. Cash payments to site staff, supervisors, or drivers are strictly not accepted and shall not be recognized as valid payment."
     },
     {
      "no": "2.5",
      "text": "Retention or Withholding: Any retention amount, if applicable, must be specifically agreed in writing prior to supply. No deduction or withholding shall be made from payments without prior written consent from the supplier."
     },
     {
      "no": "2.6",
      "text": "Price Revision: The Supplier reserves the right to amend prices in the event of any change in mix design, raw material costs, transportation, diesel prices, or due to change/introduction of taxes, duties, statutory levies, or applicable rules and regulations."
     },
     {
      "no": "2.7",
      "text": "Invoice Disputes: Each load of concrete supplied shall be accompanied by an invoice indicating the quantity and value supplied. The same shall be acknowledged by an authorized representative of the Customer and shall form the basis for payment. Any claims or disputes concerning invoices must be notified in writing within {dispute_hours} hours from completion of pour. Non-payment shall not be justified on the basis of pending or unreported disputes after this period."
     },
     {
      "no": "2.8",
      "text": "Delayed Payment: As an Udyam-registered MSME (UDYAM-KL-05-0008048), any delay in payment shall attract action under the provisions of the MSME Development Act, 2006, including interest as prescribed thereunder, in addition to other remedies available under law. \nWithout prejudice to the above, interest @ {interest_pct}% per annum shall be charged on all delayed payments from the due date until realization. Continuous or repeated delays in payment may result in suspension or discontinuation of supply without prior notice, without any liability on the Supplier for project delays or consequential losses."
     },
     {
      "no": "2.9",
      "kind": "bank",
      "text": ""
     }
    ]
   },
   {
    "no": "3",
    "title": "Order Placement & Delivery",
    "clauses": [
     {
      "no": "3.1",
      "text": "It shall be the sole responsibility of the Contractor/Customer to provide safe, clear, and well-maintained access to the site for the Supplier’s transit mixers, pumps, and other vehicles. Adequate access roads, turning radius, load-bearing capacity, and working space shall be ensured to meet safety standards and to avoid damage to the Supplier’s vehicles and equipment."
     },
     {
      "no": "3.2",
      "text": "The Supplier shall not be responsible for any shortage or excess arising from miscalculation of quantities by the Customer, including during the final stages of pouring. The Customer or their authorized representative shall, at the time of calculating the balance quantity required, verify the remaining concrete quantity available in the transit mixer at site, and shall accept and utilize such remaining concrete.\nOnce concrete is batched and mixed at the plant as per the Customer’s confirmed order, payment shall be due in full, irrespective of whether the concrete is fully utilized. No return, cancellation, or rejection of such concrete shall be accepted under any circumstances."
     },
     {
      "no": "3.3",
      "text": "The Contractor/Customer shall ensure that the site is fully ready for concreting and that all necessary resources, including but not limited to manpower, shuttering, reinforcement, vibrators, power supply, water, lighting, and access arrangements, are available to complete the pour without interruption."
     },
     {
      "no": "3.4",
      "text": "The quoted price does not include spreading, vibration, finishing, curing, or any related site works unless explicitly agreed in writing by the Supplier."
     },
     {
      "no": "3.5",
      "text": "Concrete orders must be submitted at least 3 (Three) Days in advance, in a duly filled and authorized concrete order form or Purchase Order. Orders are subject to plant capacity and confirmation by the Supplier."
     },
     {
      "no": "3.6",
      "text": "Any permissions, approvals, or clearances required from site authorities, local bodies, traffic authorities, police, residents’ associations, or any other statutory authority for the movement, parking, pumping, or placement of concrete shall be arranged by the Contractor/Customer at their own cost and responsibility."
     },
     {
      "no": "3.7",
      "text": "Any delay, loss, or damage arising due to non-availability of permissions, site readiness, safety arrangements, or resources shall be entirely at the Customer’s risk and cost."
     },
     {
      "no": "3.8",
      "text": "The Contractor/Customer shall be solely responsible for maintaining safety within the site premises, including the safety of the Supplier’s vehicles, equipment, operators, and workmen while inside the site."
     },
     {
      "no": "3.9",
      "text": "The Supplier shall not be responsible or liable for any accident, injury, loss of life, or damage to property occurring within the site premises during delivery, pumping, or unloading of concrete, except where caused solely due to the Supplier’s gross negligence. All risks at site shall be borne by the Contractor/Customer."
     }
    ]
   },
   {
    "no": "4",
    "title": "Quality & Responsibility",
    "clauses": [
     {
      "no": "4.1",
      "text": "Concrete shall be supplied strictly in accordance with the approved grade and mix design specified in the Customer’s order and confirmed by the Supplier. Any change in grade, mix design, slump, or performance parameters shall require prior written approval from the Supplier."
     },
     {
      "no": "4.2",
      "text": "Concrete shall be supplied with a standard slump of 100 ± 25 mm, unless otherwise specified in writing. Any variation in slump requirements must be clearly mentioned in the duly filled concrete order form."
     },
     {
      "no": "4.3",
      "text": "The Supplier shall not be responsible for any modification, alteration, addition of water, re-tempering, or admixture addition carried out after the concrete reaches the project site, nor for any quality, strength, durability, or performance consequences arising therefrom."
     },
     {
      "no": "4.4",
      "text": "The 28-day compressive strength of the concrete is guaranteed only when sampling and cube preparation are carried out by the Supplier technicians, and the cubes are properly cured and tested at approved laboratories in accordance with the relevant IS standards. Cube test results shall be considered valid only under such conditions."
     },
     {
      "no": "4.5",
      "text": "The Supplier shall be responsible for concrete quality up to the point of delivery and discharge at site, provided the concrete is handled, placed, compacted, finished, cured, and protected properly by the Customer. Improper handling, delayed placement, re-tempering, excessive or inadequate vibration, poor finishing, insufficient curing, exposure to adverse weather, or site delays shall absolve the Supplier of responsibility for strength or quality failures."
     },
     {
      "no": "4.6",
      "text": "The Supplier shall not be held responsible for any plastic shrinkage, settlement cracks, drying shrinkage, or restraining cracks. We will not entertain any claims for repair, as such cracks typically result from improper handling of concrete during casting, or from the absence of crack control measures such as contraction joints, adequate reinforcement, or timely curing -all of which are beyond our scope of work."
     }
    ]
   },
   {
    "no": "5",
    "title": "Pour Instructions",
    "clauses": [
     {
      "no": "5.1",
      "text": "Ensure that the existing floor/slab is structurally adequate to safely support the weight of the Ready-Mix Concrete during placement."
     },
     {
      "no": "5.2",
      "text": "Prior to concrete placement, thoroughly wet the slab surface to achieve a Saturated Surface Dry (SSD) condition. Free-standing water shall be removed."
     },
     {
      "no": "5.3",
      "text": "Place the concrete accurately and compact it properly using mechanical vibrators to eliminate air voids and ensure uniform consolidation"
     },
     {
      "no": "5.4",
      "text": "Restrict access to the slab area during concrete placement. Only essential and authorized personnel shall be permitted."
     },
     {
      "no": "5.5",
      "text": "Finish and level the concrete accurately to the specified levels and slopes as per approved drawings."
     },
     {
      "no": "5.6",
      "text": "All concrete-lined and finished areas shall be wetted with water strictly in accordance with the prescribed curing procedure."
     },
     {
      "no": "5.7",
      "text": "Immediately after finishing, cover the concrete surface with suitable protective sheets (such as plastic or hessian) to prevent direct sunlight and rapid moisture loss. Wet the surface with the prescribed quantity of water."
     },
     {
      "no": "5.8",
      "text": "After a minimum of 12 hours from concrete placement, commence continuous curing by soaking the concrete with water for a period of 14 days, unless otherwise specified."
     },
     {
      "no": "5.9",
      "text": "Under no circumstances shall shuttering/formwork materials be removed or replaced before the completion of 14 days from the date of concrete placement."
     }
    ]
   },
   {
    "no": "6",
    "title": "Force Majeure & Dispute Resolution",
    "clauses": [
     {
      "no": "6.1",
      "text": "Force Majeure: The Supplier shall not be liable for any delay or failure in performance or delivery due to events beyond its reasonable control, including but not limited to natural calamities, acts of God, strikes, lockouts, labour disturbances, machinery breakdowns, power failures, transport disruptions, government restrictions, or any other force majeure events."
     },
     {
      "no": "6.2",
      "text": "Arbitration: Any dispute, difference, or claim arising out of or in connection with this Quotation-cum-Agreement, including its interpretation, performance, breach, or termination, shall be referred to and finally resolved by arbitration in accordance with the provisions of the Arbitration and Conciliation Act, 1996, as amended from time to time.\nThe arbitration shall be conducted by a sole arbitrator appointed by the Supplier. The seat and venue of arbitration shall be Kasaragod, Kerala, and the arbitration proceedings shall be conducted in English. The arbitral award shall be final and binding on both parties. This arbitration clause shall survive termination or completion of the agreement."
     },
     {
      "no": "6.3",
      "text": "Jurisdiction: Subject to Clause 6.2 above, the courts at Kasaragod, Kerala, shall have exclusive jurisdiction in respect of all matters arising out of or in connection with this agreement."
     }
    ]
   },
   {
    "no": "7",
    "title": "Liability",
    "clauses": [
     {
      "no": "",
      "text": "Supplier’s total liability, if any, shall be strictly limited to the invoice value of the concrete supplied giving rise to the claim. No consequential or indirect damages shall be payable."
     }
    ]
   },
   {
    "no": "8",
    "title": "Validity",
    "clauses": [
     {
      "no": "",
      "text": "This quotation shall be valid for a period of {validity_text} days from the date of issue. If the quotation is not approved, duly signed, and returned within the validity period, it shall be deemed to have expired.\nHowever, in the event the Customer places an order, issues delivery instructions, or accepts delivery of concrete during or after the validity period, such action shall be deemed acceptance of this quotation-cum-agreement and all terms and conditions stated herein."
     }
    ]
   },
   {
    "no": "9",
    "title": "Deemed Acceptance",
    "clauses": [
     {
      "no": "9.1",
      "text": "Placing a purchase order, issuing delivery instructions, accepting delivery of concrete, or permitting discharge of concrete at site shall be deemed to constitute unconditional acceptance of this Quotation-cum-Agreement and all terms and conditions stated herein, notwithstanding whether the document is formally signed or returned by the Customer. Commencement of supply shall be treated as conclusive acceptance of the agreement"
     },
     {
      "no": "9.2",
      "text": "Precedence of Terms: Notwithstanding any purchase order, work order, or document issued by the Customer, the terms and conditions of this Quotation-cum-Agreement shall prevail. Acceptance of any purchase order or commencement of supply shall not be construed as acceptance of any additional, inconsistent, or conflicting terms contained therein, unless expressly agreed in writing by the Supplier."
     }
    ]
   }
  ],
  "closing": [
   "Hope this competitive proposal shall meet your requirements, feel free to contact us should you have any clarification, and expect to hear from you soon with confirmation and acceptance of the proposal",
   "By signing below, the Customer confirms acceptance of this Quotation cum Agreement along with all terms and conditions mentioned herein, which shall be legally binding."
  ]
 },
 "credit": {
  "parties": [
   "This Quotation-cum-Agreement (“Agreement”) is issued by Our Own Ready Mix, a business entity having its principal place of business at Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala, India, PIN-671321 and registered under the Goods and Services Tax laws with GSTIN: 32AAGFO7545J1Z2, (hereinafter referred to as the “Supplier”, which expression shall, unless repugnant to the context, include its proprietors, partners, successors, and permitted assigns).",
   "The Agreement is accepted by the customer whose name, billing address, and GST details (if applicable) are mentioned herein (hereinafter referred to as the “Customer”)."
  ],
  "sections": [
   {
    "no": "1",
    "title": "Additional & Service Charges",
    "clauses": [
     {
      "no": "1.1",
      "text": "If ordered quantity is less than {line_pump_min_qty} cubic meter, line pump mobilization charge of ₹{line_pump_charge}/- per day will be applicable"
     },
     {
      "no": "1.2",
      "text": "Mobile pump (Boom Placer) can be provided for any quantity of concrete, a minimum pumping charge of ₹{boom_min_charge}/- will apply for orders up to {boom_min_qty} cubic meter{boom_above_text}"
     },
     {
      "no": "1.3",
      "text": "If ordered quantity per truck is less than {part_load_min_qty} cubic meter, part load charge of ₹{part_load_rate}/- will be charged on each cubic meter below {part_load_min_qty} cubic meter"
     },
     {
      "no": "1.4",
      "text": "{waterproofing_text}"
     },
     {
      "no": "1.5",
      "text": "{fiber_text}"
     },
     {
      "no": "1.6",
      "text": "Concrete in the Transit Mixer shall be fully unloaded and the vehicle released within {waiting_free_hours_text} hours from the time of arrival at site. Any delay beyond this free period, for reasons not attributable to the Supplier, shall attract waiting / detention charges @ ₹{waiting_rate} per hour or part thereof, calculated from the expiry of the free period until the vehicle is fully unloaded and released from the site."
     },
     {
      "no": "1.7",
      "text": "The above quoted price is for the cement content mentioned by us as per our Standard Mix Design. In case of any additional cement content, an additional amount shall be charged at ₹{extra_cement_rate}/- per kilogram."
     }
    ]
   },
   {
    "no": "2",
    "title": "Payment Terms and Conditions",
    "clauses": [
     {
      "no": "2.1",
      "text": "Credit Facility: The customer is approved for supply on a credit basis. The credit facility is subject to compliance with the terms and conditions stated herein:"
     },
     {
      "no": "2.2",
      "text": "Credit Period : The approved credit period shall be {credit_days} days from the date of invoice. No extension of the credit period shall be allowed unless expressly agreed in writing by the Supplier."
     },
     {
      "no": "2.3",
      "text": "Credit Limit : The maximum outstanding amount permitted at any time shall not exceed ₹{credit_limit}. The Supplier reserves the right to revise, reduce, or withdraw the credit limit at its sole discretion based on payment performance."
     },
     {
      "no": "2.4",
      "text": "Security for Payment: To secure payment obligations under this Quotation-cum-Agreement, the Customer shall provide Post-Dated Security Cheque(s) equivalent to the approved credit limit, drawn in favour of the Supplier, either by the Contracting Customer and/or by the billing entity, as instructed by the Customer.\nSuch security cheque(s) shall be treated strictly as security and may be presented for encashment in the event of default, delayed payment, or breach of credit terms, irrespective of whether the invoice is raised on the Contracting Customer or on any third party. Dishonour of any security cheque shall attract action under applicable laws, including the Negotiable Instruments Act, 1881, without prejudice to the Supplier’s rights to recover dues from the Contracting Customer and/or the billing entity under this agreement."
     },
     {
      "no": "2.5",
      "text": "Billing Instructions & Payment Responsibility : The Customer placing the order and accepting this Quotation-cum-Agreement (“Contracting Customer”) shall remain fully and unconditionally liable for payment of all supplies made under this agreement, irrespective of whether the GST tax invoice is issued in the name of the Contracting Customer or in the name of any other entity (including sister concerns, group companies, affiliates, or nominees) as instructed by the Contracting Customer.\nAny request to issue the GST tax invoice to a third party shall be treated solely as a billing instruction and shall not constitute novation, assignment, or transfer of contractual or payment obligations. The Contracting Customer warrants that it has the legal authority to bind such third-party billing entities to the payment terms of this Agreement. In the event such authority is disputed or found invalid, the Contracting Customer shall remain solely and fully liable for all payment obligations. Where invoices are raised in the name of a third party, the Contracting Customer and the billing entity shall be jointly and severally liable for payment of the invoice value, including applicable GST, interest, detention charges, and penalties. The Supplier shall not be responsible for any denial of Input Tax Credit (ITC) to any party arising from incorrect GST details or non-compliance by the Customer or billing entity. The Contracting Customer agrees to indemnify and hold the Supplier harmless against any tax demands, ITC reversals, interest, penalties, or proceedings under CGST, SGST, IGST, or other applicable laws arising from third-party billing instructions."
     },
     {
      "no": "2.6",
      "text": "Mode of Payment: Payments shall be made by Account Transfer / UPI / Cheque, payable to Our Own Ready Mix.\nAll payments shall be made strictly to the Suppliers official bank account. In case of cash payment, an official cash receipt must be collected at the time of payment. Cash payments to site staff, supervisors, or drivers are strictly not accepted and shall not be recognized as valid payment."
     },
     {
      "no": "2.7",
      "text": "Retention or Withholding: Any retention amount, if applicable, must be specifically agreed in writing prior to supply. No deduction or withholding shall be made from payments without prior written consent from the supplier."
     },
     {
      "no": "2.8",
      "text": "Price Revision: The Supplier reserves the right to amend prices in the event of any change in mix design, raw material costs, transportation, diesel prices, or due to change/introduction of taxes, duties, statutory levies, or applicable rules and regulations."
     },
     {
      "no": "2.9",
      "text": "Delayed Payment: As an Udyam-registered MSME (UDYAM-KL-05-0008048), any delay in payment beyond the stipulated credit period shall attract action under the provisions of the MSME Development Act, 2006, including interest as prescribed thereunder, in addition to other remedies available under law. \nWithout prejudice to the above, interest @ {interest_pct}% per annum shall be charged on all delayed payments from the due date until realization. Continuous or repeated delays in payment may result in suspension or discontinuation of supply without prior notice, without any liability on the Supplier for project delays or consequential losses."
     },
     {
      "no": "2.10",
      "text": "Invoice Disputes: Each load of concrete supplied shall be accompanied by an invoice indicating the quantity and value supplied. The same shall be acknowledged by an authorized representative of the Customer and shall form the basis for payment. Any claims or disputes concerning invoices must be notified in writing within {dispute_hours} hours from completion of pour. No claims shall be entertained thereafter."
     },
     {
      "no": "2.11",
      "kind": "bank",
      "text": ""
     }
    ]
   },
   {
    "no": "3",
    "title": "Order Placement & Delivery",
    "clauses": [
     {
      "no": "3.1",
      "text": "It shall be the sole responsibility of the Contractor/Customer to provide safe, clear, and well-maintained access to the site for the Supplier’s transit mixers, pumps, and other vehicles. Adequate access roads, turning radius, load-bearing capacity, and working space shall be ensured to meet safety standards and to avoid damage to the Supplier’s vehicles and equipment."
     },
     {
      "no": "3.2",
      "text": "The Supplier shall not be responsible for any shortage or excess arising from miscalculation of quantities by the Customer, including during the final stages of pouring. The Customer or their authorized representative shall, at the time of calculating the balance quantity required, verify the remaining concrete quantity available in the transit mixer at site, and shall accept and utilize such remaining concrete.\nOnce concrete is batched and mixed at the plant as per the Customer’s confirmed order, payment shall be due in full, irrespective of whether the concrete is fully utilized. No return, cancellation, or rejection of such concrete shall be accepted under any circumstances."
     },
     {
      "no": "3.3",
      "text": "The Contractor/Customer shall ensure that the site is fully ready for concreting and that all necessary resources, including but not limited to manpower, shuttering, reinforcement, vibrators, power supply, water, lighting, and access arrangements, are available to complete the pour without interruption."
     },
     {
      "no": "3.4",
      "text": "The quoted price does not include spreading, vibration, finishing, curing, or any related site works unless explicitly agreed in writing by the Supplier."
     },
     {
      "no": "3.5",
      "text": "Concrete orders must be submitted at least 3 (Three) Days in advance, in a duly filled and authorized concrete order form or Purchase Order. Orders are subject to plant capacity and confirmation by the Supplier."
     },
     {
      "no": "3.6",
      "text": "Any permissions, approvals, or clearances required from site authorities, local bodies, traffic authorities, police, residents’ associations, or any other statutory authority for the movement, parking, pumping, or placement of concrete shall be arranged by the Contractor/Customer at their own cost and responsibility."
     },
     {
      "no": "3.7",
      "text": "Any delay, loss, or damage arising due to non-availability of permissions, site readiness, safety arrangements, or resources shall be entirely at the Customer’s risk and cost."
     },
     {
      "no": "3.8",
      "text": "The Contractor/Customer shall be solely responsible for maintaining safety within the site premises, including the safety of the Supplier’s vehicles, equipment, operators, and workmen while inside the site."
     },
     {
      "no": "3.9",
      "text": "The Supplier shall not be responsible or liable for any accident, injury, loss of life, or damage to property occurring within the site premises during delivery, pumping, or unloading of concrete, except where caused solely due to the Supplier’s gross negligence. All risks at site shall be borne by the Contractor/Customer."
     }
    ]
   },
   {
    "no": "4",
    "title": "Quality & Responsibility",
    "clauses": [
     {
      "no": "4.1",
      "text": "Concrete shall be supplied strictly in accordance with the approved grade and mix design specified in the Customer’s order and confirmed by the Supplier. Any change in grade, mix design, slump, or performance parameters shall require prior written approval from the Supplier."
     },
     {
      "no": "4.2",
      "text": "Concrete shall be supplied with a standard slump of 100 ± 25 mm, unless otherwise specified in writing. Any variation in slump requirements must be clearly mentioned in the duly filled concrete order form."
     },
     {
      "no": "4.3",
      "text": "The Supplier shall not be responsible for any modification, alteration, addition of water, re-tempering, or admixture addition carried out after the concrete reaches the project site, nor for any quality, strength, durability, or performance consequences arising therefrom."
     },
     {
      "no": "4.4",
      "text": "The 28-day compressive strength of the concrete is guaranteed only when sampling and cube preparation are carried out by the Supplier technicians, and the cubes are properly cured and tested at approved laboratories in accordance with the relevant IS standards. Cube test results shall be considered valid only under such conditions."
     },
     {
      "no": "4.5",
      "text": "The Supplier shall be responsible for concrete quality up to the point of delivery and discharge at site, provided the concrete is handled, placed, compacted, finished, cured, and protected properly by the Customer. Improper handling, delayed placement, re-tempering, excessive or inadequate vibration, poor finishing, insufficient curing, exposure to adverse weather, or site delays shall absolve the Supplier of responsibility for strength or quality failures."
     },
     {
      "no": "4.6",
      "text": "The Supplier shall not be held responsible for any plastic shrinkage, settlement cracks, drying shrinkage, or restraining cracks. We will not entertain any claims for repair, as such cracks typically result from improper handling of concrete during casting, or from the absence of crack control measures such as contraction joints, adequate reinforcement, or timely curing -all of which are beyond our scope of work."
     }
    ]
   },
   {
    "no": "5",
    "title": "Pour Instructions",
    "clauses": [
     {
      "no": "5.1",
      "text": "Ensure that the existing floor/slab is structurally adequate to safely support the weight of the Ready-Mix Concrete during placement."
     },
     {
      "no": "5.2",
      "text": "Prior to concrete placement, thoroughly wet the slab surface to achieve a Saturated Surface Dry (SSD) condition. Free-standing water shall be removed."
     },
     {
      "no": "5.3",
      "text": "Place the concrete accurately and compact it properly using mechanical vibrators to eliminate air voids and ensure uniform consolidation"
     },
     {
      "no": "5.4",
      "text": "Restrict access to the roof/slab area during concrete placement. Only essential and authorized personnel shall be permitted."
     },
     {
      "no": "5.5",
      "text": "Finish and level the concrete accurately to the specified levels and slopes as per approved drawings."
     },
     {
      "no": "5.6",
      "text": "All concrete-lined and finished areas shall be wetted with water strictly in accordance with the prescribed curing procedure."
     },
     {
      "no": "5.7",
      "text": "Immediately after finishing, cover the concrete surface with suitable protective sheets (such as plastic or hessian) to prevent direct sunlight and rapid moisture loss. Wet the surface with the prescribed quantity of water."
     },
     {
      "no": "5.8",
      "text": "After a minimum of 12 hours from concrete placement, commence continuous curing by soaking the concrete with water for a period of 14 days, unless otherwise specified."
     },
     {
      "no": "5.9",
      "text": "Under no circumstances shall shuttering/formwork materials be removed or replaced before the completion of 14 days from the date of concrete placement."
     }
    ]
   },
   {
    "no": "6",
    "title": "Force Majeure & Dispute Resolution",
    "clauses": [
     {
      "no": "6.1",
      "text": "Force Majeure: The Supplier shall not be liable for any delay or failure in performance or delivery due to events beyond its reasonable control, including but not limited to natural calamities, acts of God, strikes, lockouts, labour disturbances, machinery breakdowns, power failures, transport disruptions, government restrictions, or any other force majeure events."
     },
     {
      "no": "6.2",
      "text": "Arbitration: Any dispute, difference, or claim arising out of or in connection with this Quotation-cum-Agreement, including its interpretation, performance, breach, or termination, shall be referred to and finally resolved by arbitration in accordance with the provisions of the Arbitration and Conciliation Act, 1996, as amended from time to time.\nThe arbitration shall be conducted by a sole arbitrator appointed by the Supplier. The seat and venue of arbitration shall be Kasaragod, Kerala, and the arbitration proceedings shall be conducted in English. The arbitral award shall be final and binding on both parties. This arbitration clause shall survive termination or completion of the agreement."
     },
     {
      "no": "6.3",
      "text": "Jurisdiction: Subject to Clause 6.2 above, the courts at Kasaragod, Kerala, shall have exclusive jurisdiction in respect of all matters arising out of or in connection with this agreement."
     }
    ]
   },
   {
    "no": "7",
    "title": "Liability",
    "clauses": [
     {
      "no": "",
      "text": "Supplier’s total liability, if any, shall be strictly limited to the invoice value of the concrete supplied giving rise to the claim. No consequential or indirect damages shall be payable."
     }
    ]
   },
   {
    "no": "8",
    "title": "Validity",
    "clauses": [
     {
      "no": "",
      "text": "This quotation shall be valid for a period of {validity_text} days from the date of issue. If the quotation is not approved, duly signed, and returned within the validity period, it shall be deemed to have expired.\nHowever, in the event the Customer places an order, issues delivery instructions, or accepts delivery of concrete during or after the validity period, such action shall be deemed acceptance of this quotation-cum-agreement and all terms and conditions stated herein."
     }
    ]
   },
   {
    "no": "9",
    "title": "Deemed Acceptance",
    "clauses": [
     {
      "no": "9.1",
      "text": "Placing a purchase order, issuing delivery instructions, accepting delivery of concrete, or permitting discharge of concrete at site shall be deemed to constitute unconditional acceptance of this Quotation-cum-Agreement and all terms and conditions stated herein, notwithstanding whether the document is formally signed or returned by the Customer. Commencement of supply shall be treated as conclusive acceptance of the agreement"
     },
     {
      "no": "9.2",
      "text": "Precedence of Terms: Notwithstanding any purchase order, work order, or document issued by the Customer, the terms and conditions of this Quotation-cum-Agreement shall prevail. Acceptance of any purchase order or commencement of supply shall not be construed as acceptance of any additional, inconsistent, or conflicting terms contained therein, unless expressly agreed in writing by the Supplier."
     }
    ]
   }
  ],
  "closing": [
   "Hope this competitive proposal shall meet your requirements, feel free to contact us should you have any clarification, and expect to hear from you soon with confirmation and acceptance of the proposal",
   "By signing below, the Customer confirms acceptance of this Quotation cum Agreement along with all terms and conditions mentioned herein, which shall be legally binding."
  ]
 },
 "credit_qty": {
  "parties": [
   "This Quotation-cum-Agreement (“Agreement”) is issued by Our Own Ready Mix, a business entity having its principal place of business at Plot 3C-2, Ananthapuram Development Plot, Kasaragod, Kerala, India, PIN-671321 and registered under the Goods and Services Tax laws with GSTIN: 32AAGFO7545J1Z2, (hereinafter referred to as the “Supplier”, which expression shall, unless repugnant to the context, include its proprietors, partners, successors, and permitted assigns).",
   "The Agreement is accepted by the customer whose name, billing address, and GST details (if applicable) are mentioned herein (hereinafter referred to as the “Customer”)."
  ],
  "sections": [
   {
    "no": "1",
    "title": "Additional & Service Charges",
    "clauses": [
     {
      "no": "1.1",
      "text": "If ordered quantity is less than {line_pump_min_qty} cubic meter, line pump mobilization charge of ₹{line_pump_charge}/- per day will be applicable"
     },
     {
      "no": "1.2",
      "text": "Mobile pump (Boom Placer) can be provided for any quantity of concrete, a minimum pumping charge of ₹{boom_min_charge}/- will apply for orders up to {boom_min_qty} cubic meter{boom_above_text}"
     },
     {
      "no": "1.3",
      "text": "If ordered quantity per truck is less than {part_load_min_qty} cubic meter, part load charge of ₹{part_load_rate}/- will be charged on each cubic meter below {part_load_min_qty} cubic meter"
     },
     {
      "no": "1.4",
      "text": "{waterproofing_text}"
     },
     {
      "no": "1.5",
      "text": "{fiber_text}"
     },
     {
      "no": "1.6",
      "text": "Concrete in the Transit Mixer shall be fully unloaded and the vehicle released within {waiting_free_hours_text} hours from the time of arrival at site. Any delay beyond this free period, for reasons not attributable to the Supplier, shall attract waiting / detention charges @ ₹{waiting_rate} per hour or part thereof, calculated from the expiry of the free period until the vehicle is fully unloaded and released from the site."
     },
     {
      "no": "1.7",
      "text": "The above quoted price is for the cement content mentioned by us as per our Standard Mix Design. In case of any additional cement content, an additional amount shall be charged at ₹{extra_cement_rate}/- per kilogram."
     },
     {
      "no": "1.8",
      "text": "Grade-Wise Volume Commitment & Rebate: The quantities mentioned in the rate table as “Committed Quantity (m³)” represent the Customer’s projected minimum requirement and form the commercial basis for pricing and rebate eligibility under this agreement. The rates quoted herein are extended considering the anticipated volume from the Customer’s project.\nRebate: ₹{rebate}/- per m³\nThe rebate for a particular grade shall be applicable only if the committed quantity for that grade is fully achieved, irrespective of quantities supplied for any other grade. In the event the committed quantity for any grade is not achieved, no rebate or discount shall be applicable for that grade, and the invoiced rate shall be treated as final. The Supplier reserves the right to withdraw the volume-based pricing benefit where the committed quantities are not achieved. Any rebate, if applicable, shall be calculated and issued only after completion of supply or achievement of the committed quantity for the respective grade, whichever occurs earlier."
     }
    ]
   },
   {
    "no": "2",
    "title": "Payment Terms and Conditions",
    "clauses": [
     {
      "no": "2.1",
      "text": "Credit Facility: The customer is approved for supply on a credit basis. The credit facility is subject to compliance with the terms and conditions stated herein:"
     },
     {
      "no": "2.2",
      "text": "Credit Period : The approved credit period shall be {credit_days} days from the date of invoice. No extension of the credit period shall be allowed unless expressly agreed in writing by the Supplier."
     },
     {
      "no": "2.3",
      "text": "Credit Limit : The maximum outstanding amount permitted at any time shall not exceed ₹{credit_limit}. The Supplier reserves the right to revise, reduce, or withdraw the credit limit at its sole discretion based on payment performance."
     },
     {
      "no": "2.4",
      "text": "Security for Payment: To secure payment obligations under this Quotation-cum-Agreement, the Customer shall provide Post-Dated Security Cheque(s) equivalent to the approved credit limit, drawn in favour of the Supplier, either by the Contracting Customer and/or by the billing entity, as instructed by the Customer.\nSuch security cheque(s) shall be treated strictly as security and may be presented for encashment in the event of default, delayed payment, or breach of credit terms, irrespective of whether the invoice is raised on the Contracting Customer or on any third party. Dishonour of any security cheque shall attract action under applicable laws, including the Negotiable Instruments Act, 1881, without prejudice to the Supplier’s rights to recover dues from the Contracting Customer and/or the billing entity under this agreement."
     },
     {
      "no": "2.5",
      "text": "Mode of Payment: Payments shall be made by Account Transfer / UPI / Cheque, payable to Our Own Ready Mix.\nAll payments shall be made strictly to the Suppliers official bank account. In case of cash payment, an official cash receipt must be collected at the time of payment. Cash payments to site staff, supervisors, or drivers are strictly not accepted and shall not be recognized as valid payment."
     },
     {
      "no": "2.6",
      "text": "Retention or Withholding: Any retention amount, if applicable, must be specifically agreed in writing prior to supply. No deduction or withholding shall be made from payments without prior written consent from the supplier."
     },
     {
      "no": "2.7",
      "text": "Price Revision: The Supplier reserves the right to amend prices in the event of any change in mix design, raw material costs, transportation, diesel prices, or due to change/introduction of taxes, duties, statutory levies, or applicable rules and regulations."
     },
     {
      "no": "2.8",
      "text": "Billing Instructions & Payment Responsibility : The Customer placing the order and accepting this Quotation-cum-Agreement (“Contracting Customer”) shall remain fully and unconditionally liable for payment of all supplies made under this agreement, irrespective of whether the GST tax invoice is issued in the name of the Contracting Customer or in the name of any other entity (including sister concerns, group companies, affiliates, or nominees) as instructed by the Contracting Customer.\nAny request to issue the GST tax invoice to a third party shall be treated solely as a billing instruction and shall not constitute novation, assignment, or transfer of contractual or payment obligations. The Contracting Customer warrants that it has the legal authority to bind such third-party billing entities to the payment terms of this Agreement. In the event such authority is disputed or found invalid, the Contracting Customer shall remain solely and fully liable for all payment obligations. Where invoices are raised in the name of a third party, the Contracting Customer and the billing entity shall be jointly and severally liable for payment of the invoice value, including applicable GST, interest, detention charges, and penalties. The Supplier shall not be responsible for any denial of Input Tax Credit (ITC) to any party arising from incorrect GST details or non-compliance by the Customer or billing entity. The Contracting Customer agrees to indemnify and hold the Supplier harmless against any tax demands, ITC reversals, interest, penalties, or proceedings under CGST, SGST, IGST, or other applicable laws arising from third-party billing instructions."
     },
     {
      "no": "2.9",
      "text": "Delayed Payment: As an Udyam-registered MSME (UDYAM-KL-05-0008048), any delay in payment beyond the stipulated credit period shall attract action under the provisions of the MSME Development Act, 2006, including interest as prescribed thereunder, in addition to other remedies available under law. \nWithout prejudice to the above, interest @ {interest_pct}% per annum shall be charged on all delayed payments from the due date until realization. Continuous or repeated delays in payment may result in suspension or discontinuation of supply without prior notice, without any liability on the Supplier for project delays or consequential losses."
     },
     {
      "no": "2.10",
      "text": "Invoice Disputes: Each load of concrete supplied shall be accompanied by an invoice indicating the quantity and value supplied. The same shall be acknowledged by an authorized representative of the Customer and shall form the basis for payment. Any claims or disputes concerning invoices must be notified in writing within {dispute_hours} hours from completion of pour. No claims shall be entertained thereafter."
     },
     {
      "no": "2.11",
      "kind": "bank",
      "text": ""
     }
    ]
   },
   {
    "no": "3",
    "title": "Order Placement & Delivery",
    "clauses": [
     {
      "no": "3.1",
      "text": "It shall be the sole responsibility of the Contractor/Customer to provide safe, clear, and well-maintained access to the site for the Supplier’s transit mixers, pumps, and other vehicles. Adequate access roads, turning radius, load-bearing capacity, and working space shall be ensured to meet safety standards and to avoid damage to the Supplier’s vehicles and equipment."
     },
     {
      "no": "3.2",
      "text": "The Contractor/Customer shall ensure that the site is fully ready for concreting and that all necessary resources, including but not limited to manpower, shuttering, reinforcement, vibrators, power supply, water, lighting, and access arrangements, are available to complete the pour without interruption."
     },
     {
      "no": "3.3",
      "text": "The quoted price does not include spreading, vibration, finishing, curing, or any related site works unless explicitly agreed in writing by the Supplier."
     },
     {
      "no": "3.4",
      "text": "The Supplier shall not be responsible for any shortage or excess arising from miscalculation of quantities by the Customer, including during the final stages of pouring. The Customer or their authorized representative shall, at the time of calculating the balance quantity required, verify the remaining concrete quantity available in the transit mixer at site, and shall accept and utilize such remaining concrete.\nOnce concrete is batched and mixed at the plant as per the Customer’s confirmed order, payment shall be due in full, irrespective of whether the concrete is fully utilized. No return, cancellation, or rejection of such concrete shall be accepted under any circumstances."
     },
     {
      "no": "3.5",
      "text": "Concrete orders must be submitted at least 3 (Three) Days in advance, in a duly filled and authorized concrete order form or Purchase Order. Orders are subject to plant capacity and confirmation by the Supplier."
     },
     {
      "no": "3.6",
      "text": "Any permissions, approvals, or clearances required from site authorities, local bodies, traffic authorities, police, residents’ associations, or any other statutory authority for the movement, parking, pumping, or placement of concrete shall be arranged by the Contractor/Customer at their own cost and responsibility."
     },
     {
      "no": "3.7",
      "text": "Any delay, loss, or damage arising due to non-availability of permissions, site readiness, safety arrangements, or resources shall be entirely at the Customer’s risk and cost."
     },
     {
      "no": "3.8",
      "text": "The Contractor/Customer shall be solely responsible for maintaining safety within the site premises, including the safety of the Supplier’s vehicles, equipment, operators, and workmen while inside the site."
     },
     {
      "no": "3.9",
      "text": "The Supplier shall not be responsible or liable for any accident, injury, loss of life, or damage to property occurring within the site premises during delivery, pumping, or unloading of concrete, except where caused solely due to the Supplier’s gross negligence. All risks at site shall be borne by the Contractor/Customer."
     }
    ]
   },
   {
    "no": "4",
    "title": "Quality & Responsibility",
    "clauses": [
     {
      "no": "4.1",
      "text": "Concrete shall be supplied strictly in accordance with the approved grade and mix design specified in the Customer’s order and confirmed by the Supplier. Any change in grade, mix design, slump, or performance parameters shall require prior written approval from the Supplier."
     },
     {
      "no": "4.2",
      "text": "Concrete shall be supplied with a standard slump of 100 ± 25 mm, unless otherwise specified in writing. Any variation in slump requirements must be clearly mentioned in the duly filled concrete order form."
     },
     {
      "no": "4.3",
      "text": "The Supplier shall not be responsible for any modification, alteration, addition of water, re-tempering, or admixture addition carried out after the concrete reaches the project site, nor for any quality, strength, durability, or performance consequences arising therefrom."
     },
     {
      "no": "4.4",
      "text": "The 28-day compressive strength of the concrete is guaranteed only when sampling and cube preparation are carried out by the Supplier technicians, and the cubes are properly cured and tested at approved laboratories in accordance with the relevant IS standards. Cube test results shall be considered valid only under such conditions."
     },
     {
      "no": "4.5",
      "text": "The Supplier shall be responsible for concrete quality up to the point of delivery and discharge at site, provided the concrete is handled, placed, compacted, finished, cured, and protected properly by the Customer. Improper handling, delayed placement, re-tempering, excessive or inadequate vibration, poor finishing, insufficient curing, exposure to adverse weather, or site delays shall absolve the Supplier of responsibility for strength or quality failures."
     },
     {
      "no": "4.6",
      "text": "The Supplier shall not be held responsible for any plastic shrinkage, settlement cracks, drying shrinkage, or restraining cracks. We will not entertain any claims for repair, as such cracks typically result from improper handling of concrete during casting, or from the absence of crack control measures such as contraction joints, adequate reinforcement, or timely curing -all of which are beyond our scope of work."
     }
    ]
   },
   {
    "no": "5",
    "title": "Pour Instructions",
    "clauses": [
     {
      "no": "5.1",
      "text": "Ensure that the existing floor/slab is structurally adequate to safely support the weight of the Ready-Mix Concrete during placement."
     },
     {
      "no": "5.2",
      "text": "Prior to concrete placement, thoroughly wet the slab surface to achieve a Saturated Surface Dry (SSD) condition. Free-standing water shall be removed."
     },
     {
      "no": "5.3",
      "text": "Place the concrete accurately and compact it properly using mechanical vibrators to eliminate air voids and ensure uniform consolidation"
     },
     {
      "no": "5.4",
      "text": "Restrict access to the roof/slab area during concrete placement. Only essential and authorized personnel shall be permitted."
     },
     {
      "no": "5.5",
      "text": "Finish and level the concrete accurately to the specified levels and slopes as per approved drawings."
     },
     {
      "no": "5.6",
      "text": "All concrete-lined and finished areas shall be wetted with water strictly in accordance with the prescribed curing procedure."
     },
     {
      "no": "5.7",
      "text": "Immediately after finishing, cover the concrete surface with suitable protective sheets (such as plastic or hessian) to prevent direct sunlight and rapid moisture loss. Wet the surface with the prescribed quantity of water."
     },
     {
      "no": "5.8",
      "text": "After a minimum of 12 hours from concrete placement, commence continuous curing by soaking the concrete with water for a period of 14 days, unless otherwise specified."
     },
     {
      "no": "5.9",
      "text": "Under no circumstances shall shuttering/formwork materials be removed or replaced before the completion of 14 days from the date of concrete placement."
     }
    ]
   },
   {
    "no": "6",
    "title": "Force Majeure & Dispute Resolution",
    "clauses": [
     {
      "no": "6.1",
      "text": "Force Majeure: The Supplier shall not be liable for any delay or failure in performance or delivery due to events beyond its reasonable control, including but not limited to natural calamities, acts of God, strikes, lockouts, labour disturbances, machinery breakdowns, power failures, transport disruptions, government restrictions, or any other force majeure events."
     },
     {
      "no": "6.2",
      "text": "Arbitration: Any dispute, difference, or claim arising out of or in connection with this Quotation-cum-Agreement, including its interpretation, performance, breach, or termination, shall be referred to and finally resolved by arbitration in accordance with the provisions of the Arbitration and Conciliation Act, 1996, as amended from time to time.\nThe arbitration shall be conducted by a sole arbitrator appointed by the Supplier. The seat and venue of arbitration shall be Kasaragod, Kerala, and the arbitration proceedings shall be conducted in English. The arbitral award shall be final and binding on both parties. This arbitration clause shall survive termination or completion of the agreement."
     },
     {
      "no": "6.3",
      "text": "Jurisdiction: Subject to Clause 6.2 above, the courts at Kasaragod, Kerala, shall have exclusive jurisdiction in respect of all matters arising out of or in connection with this agreement."
     }
    ]
   },
   {
    "no": "7",
    "title": "Liability",
    "clauses": [
     {
      "no": "",
      "text": "Supplier’s total liability, if any, shall be strictly limited to the invoice value of the concrete supplied giving rise to the claim. No consequential or indirect damages shall be payable."
     }
    ]
   },
   {
    "no": "8",
    "title": "Validity",
    "clauses": [
     {
      "no": "",
      "text": "This quotation shall be valid for a period of {validity_text} days from the date of issue. If the quotation is not approved, duly signed, and returned within the validity period, it shall be deemed to have expired.\nHowever, in the event the Customer places an order, issues delivery instructions, or accepts delivery of concrete during or after the validity period, such action shall be deemed acceptance of this quotation-cum-agreement and all terms and conditions stated herein."
     }
    ]
   },
   {
    "no": "9",
    "title": "Deemed Acceptance",
    "clauses": [
     {
      "no": "9.1",
      "text": "Placing a purchase order, issuing delivery instructions, accepting delivery of concrete, or permitting discharge of concrete at site shall be deemed to constitute unconditional acceptance of this Quotation-cum-Agreement and all terms and conditions stated herein, notwithstanding whether the document is formally signed or returned by the Customer. Commencement of supply shall be treated as conclusive acceptance of the agreement"
     },
     {
      "no": "9.2",
      "text": "Precedence of Terms: Notwithstanding any purchase order, work order, or document issued by the Customer, the terms and conditions of this Quotation-cum-Agreement shall prevail. Acceptance of any purchase order or commencement of supply shall not be construed as acceptance of any additional, inconsistent, or conflicting terms contained therein, unless expressly agreed in writing by the Supplier."
     }
    ]
   }
  ],
  "closing": [
   "Hope this competitive proposal shall meet your requirements, feel free to contact us should you have any clarification, and expect to hear from you soon with confirmation and acceptance of the proposal",
   "By signing below, the Customer confirms acceptance of this Quotation cum Agreement along with all terms and conditions mentioned herein, which shall be legally binding."
  ]
 },
 "price_only": {
  "parties": [],
  "sections": [
   {
    "no": "",
    "title": "Additional & Service Charges",
    "clauses": [
     {
      "no": "1",
      "text": "If ordered quantity is less than {line_pump_min_qty} cubic meter, line pump mobilization charge of ₹{line_pump_charge}/- per day will be applicable"
     },
     {
      "no": "2",
      "text": "Mobile pump (Boom Placer) can be provided for any quantity of concrete, a minimum pumping charge of ₹{boom_min_charge}/- will apply for orders up to {boom_min_qty} cubic meter{boom_above_text}"
     },
     {
      "no": "3",
      "text": "If ordered quantity per truck is less than {part_load_min_qty} m3 part load charge of ₹{part_load_rate}/- will be charged on each cubic meter below {part_load_min_qty} m3"
     },
     {
      "no": "4",
      "text": "Waterproofing Admixture and Fiber can be added to concrete with additional charge"
     },
     {
      "no": "5",
      "text": "The above quoted price is as per our Standard Mix Design, any changes will be charged extra."
     }
    ]
   }
  ],
  "closing": [
   "This quotation is issued for price reference purposes only and does not constitute a binding supply agreement. Supply of concrete shall commence only upon execution of a formal Quotation-cum-Agreement between the parties. In the event supply is commenced without signing a formal agreement, such supply shall be governed by the Supplier’s standard terms and conditions in force at the time of delivery. The rates quoted herein are subject to confirmation at the time of order placement and may be revised based on changes in raw material costs, diesel prices, statutory taxes, or other applicable factors.",
   "Hope this competitive proposal shall meet your requirements, feel free to contact us should you have any clarification, and expect to hear from you soon."
  ]
 }
};
