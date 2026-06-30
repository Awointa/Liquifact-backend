// ... existing imports ...

router.post('/legal-hold', async (req, res) => {
  try {
    // Attempt creation. If a race occurs, the DB will reject the 2nd insert
    // based on the unique partial index created in the migration.
    const hold = await LegalHold.create({ 
      invoice_id: req.body.invoice_id,
      active: true,
      expires_at: req.body.expires_at 
    });
    return res.status(201).json(hold);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      /**
       * @description Maps database-level uniqueness violation to 409 Conflict.
       * Ensures atomicity regardless of concurrent application-level checks.
       */
      return res.status(409).json({ error: 'Active legal hold already exists for this invoice' });
    }
    throw error;
  }
});
