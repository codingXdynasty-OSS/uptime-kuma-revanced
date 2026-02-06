/**
 * Add config_managed column to monitor table
 * This column indicates whether a monitor is managed via config file
 */
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.boolean("config_managed").defaultTo(false).notNullable();
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("config_managed");
    });
};
