module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addIndex('legal_holds', ['invoice_id'], {
      unique: true,
      where: {
        active: true,
        expires_at: { [Sequelize.Op.gt]: Sequelize.literal('NOW()') }
      },
      name: 'unique_active_legal_hold_per_invoice'
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeIndex('legal_holds', 'unique_active_legal_hold_per_invoice');
  }
};
